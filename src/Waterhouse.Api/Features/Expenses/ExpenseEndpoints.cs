using System.Security.Claims;
using Dapper;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Expenses;

public sealed record SaveExpenseRequest(
    string ExpenseDate,
    string Description,
    int? CategoryId,
    decimal Amount,
    string? Note);

public sealed class ExpenseEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/expenses").WithTags("Expenses").RequireAuthorization(Policies.SignedIn);

        group.MapGet("/categories", Categories);
        group.MapGet("/", List);
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete).RequireAuthorization(Policies.AdminOnly);
    }

    private static IResult Categories(IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();
        var rows = connection.Query(
            "SELECT id AS Id, name AS Name FROM expense_category WHERE is_active = 1 ORDER BY name");
        return Results.Ok(rows.Select(r => new { id = (int)r.Id, name = (string)r.Name }));
    }

    private static IResult List(
        IDbConnectionFactory connectionFactory,
        string? from, string? to, string? search, int? categoryId, int pageSize = 200)
    {
        pageSize = Math.Clamp(pageSize, 1, 1000);

        var filters = new List<string> { "1=1" };
        if (!string.IsNullOrWhiteSpace(from) && Clock.IsValidDate(from)) filters.Add("e.expense_date >= @from");
        if (!string.IsNullOrWhiteSpace(to) && Clock.IsValidDate(to)) filters.Add("e.expense_date <= @to");
        if (categoryId is > 0) filters.Add("e.category_id = @categoryId");
        if (!string.IsNullOrWhiteSpace(search)) filters.Add("(e.description LIKE @search OR e.note LIKE @search)");
        var where = "WHERE " + string.Join(" AND ", filters);

        var parameters = new { from, to, categoryId, search = $"%{search}%", limit = pageSize };

        using var connection = connectionFactory.Open();

        // Named class, not a ValueTuple: Dapper binds tuples positionally.
        var summary = connection.QuerySingle<ExpenseSummary>(
            $"SELECT COUNT(*) AS Total, COALESCE(SUM(e.amount_paise), 0) AS AmountPaise FROM expense e {where}",
            parameters);

        var rows = connection.Query(
            $"""
             SELECT e.id AS Id, e.expense_date AS ExpenseDate, e.category_id AS CategoryId,
                    c.name AS CategoryName, e.description AS Description,
                    e.amount_paise AS AmountPaise, e.note AS Note
               FROM expense e
               LEFT JOIN expense_category c ON c.id = e.category_id
               {where}
              ORDER BY e.expense_date DESC, e.id DESC
              LIMIT @limit
             """, parameters);

        return Results.Ok(new
        {
            total = summary.Total,
            totalAmount = Money.ToRupees(summary.AmountPaise),
            items = rows.Select(r => new
            {
                id = (int)r.Id,
                expenseDate = (string)r.ExpenseDate,
                categoryId = (int?)r.CategoryId,
                categoryName = (string?)r.CategoryName,
                description = (string)r.Description,
                amount = Money.ToRupees((long)r.AmountPaise),
                note = (string)r.Note,
            }),
        });
    }

    private static IResult Create(
        SaveExpenseRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory, IClock clock)
    {
        if (Validate(request, clock) is { } problem) return problem;

        var user = principal.RequireUser();
        var now = Clock.NowIso();

        using var connection = connectionFactory.Open();
        var id = connection.ExecuteScalar<long>(
            """
            INSERT INTO expense (expense_date, category_id, description, amount_paise, note, created_by, created_at, updated_at)
            VALUES (@expenseDate, @categoryId, @description, @amount, @note, @userId, @now, @now);
            SELECT last_insert_rowid();
            """,
            new
            {
                expenseDate = request.ExpenseDate,
                categoryId = request.CategoryId,
                description = request.Description.Trim(),
                amount = Money.FromRupees(request.Amount),
                note = request.Note ?? string.Empty,
                userId = user.Id,
                now,
            });

        return Results.Created($"/api/expenses/{id}", new { id = (int)id });
    }

    private static IResult Update(
        int id, SaveExpenseRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory, IClock clock)
    {
        if (Validate(request, clock) is { } problem) return problem;

        var user = principal.RequireUser();
        var now = Clock.NowIso();

        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var affected = connection.Execute(
                """
                UPDATE expense
                   SET expense_date = @expenseDate, category_id = @categoryId, description = @description,
                       amount_paise = @amount, note = @note, updated_at = @now
                 WHERE id = @id
                """,
                new
                {
                    id,
                    expenseDate = request.ExpenseDate,
                    categoryId = request.CategoryId,
                    description = request.Description.Trim(),
                    amount = Money.FromRupees(request.Amount),
                    note = request.Note ?? string.Empty,
                    now,
                }, transaction);

            if (affected == 0) return ApiResults.NotFound("Expense", id);

            connection.Execute(
                """
                INSERT INTO audit_log (entity, entity_id, action, detail, user_id, created_at)
                VALUES ('expense', @id, 'UPDATE', '', @userId, @now)
                """, new { id, userId = user.Id, now }, transaction);

            return Results.NoContent();
        });
    }

    private static IResult Delete(int id, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory)
    {
        var user = principal.RequireUser();
        var now = Clock.NowIso();

        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            // Expenses are the one record safe to remove outright: nothing else
            // references them, and a mistyped expense is more usefully deleted
            // than voided. Sales and stock movements are never deleted.
            var affected = connection.Execute("DELETE FROM expense WHERE id = @id", new { id }, transaction);
            if (affected == 0) return ApiResults.NotFound("Expense", id);

            connection.Execute(
                """
                INSERT INTO audit_log (entity, entity_id, action, detail, user_id, created_at)
                VALUES ('expense', @id, 'DELETE', '', @userId, @now)
                """, new { id, userId = user.Id, now }, transaction);

            return Results.NoContent();
        });
    }

    private static IResult? Validate(SaveExpenseRequest request, IClock clock)
    {
        var validator = new Validator()
            .RequireDate(request.ExpenseDate, "expenseDate")
            .RequireText(request.Description, "description", 255)
            .Require(request.Amount >= 0, "amount", "Cannot be negative.")
            .RequireRange(request.Amount, 0, 10_000_000, "amount");

        if (Clock.IsValidDate(request.ExpenseDate) &&
            string.CompareOrdinal(request.ExpenseDate, clock.Today()) > 0)
        {
            validator.Add("expenseDate", "Cannot be in the future.");
        }

        return validator.Problem();
    }

    private sealed class ExpenseSummary
    {
        public int Total { get; init; }
        public long AmountPaise { get; init; }
    }
}

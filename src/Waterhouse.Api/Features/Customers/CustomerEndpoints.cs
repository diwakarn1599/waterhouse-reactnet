using System.Security.Claims;
using Dapper;
using Waterhouse.Api.Features.Sales;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Customers;

public sealed record CustomerRateInput(int ProductId, decimal Rate);

public sealed record SaveCustomerRequest(
    string Name,
    string? CompanyName,
    string? Phone,
    string? Address,
    bool IsActive,
    List<CustomerRateInput>? Rates);

public sealed class CustomerEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/customers").WithTags("Customers").RequireAuthorization(Policies.SignedIn);

        group.MapGet("/", List);
        group.MapGet("/{id:int}", GetById);
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapGet("/{id:int}/ledger", Ledger);
    }

    private static IResult List(IDbConnectionFactory connectionFactory, string? search, bool includeInactive = false)
    {
        using var connection = connectionFactory.Open();

        var filters = new List<string>();
        if (!includeInactive) filters.Add("c.is_active = 1");
        if (!string.IsNullOrWhiteSpace(search))
        {
            filters.Add("(c.name LIKE @search OR c.code LIKE @search OR c.phone LIKE @search OR c.company_name LIKE @search)");
        }
        var where = filters.Count > 0 ? "WHERE " + string.Join(" AND ", filters) : string.Empty;

        var rows = connection.Query(
            $"""
             SELECT c.id AS Id, c.code AS Code, c.name AS Name, c.company_name AS CompanyName,
                    c.phone AS Phone, c.address AS Address, c.note AS Note, c.is_active AS IsActive,
                    COALESCE((SELECT SUM(s.balance_amount_paise) FROM sale s
                               WHERE s.customer_id = c.id AND s.is_void = 0 AND s.balance_amount_paise <> 0), 0) AS BalancePaise
               FROM customer c
               {where}
              ORDER BY c.name COLLATE NOCASE
             """, new { search = $"%{search}%" });

        return Results.Ok(rows.Select(r => new
        {
            id = (int)r.Id,
            code = (string)r.Code,
            name = (string)r.Name,
            companyName = (string)r.CompanyName,
            phone = (string)r.Phone,
            address = (string)r.Address,
            note = (string)r.Note,
            isActive = (long)r.IsActive == 1,
            balance = Money.ToRupees((long)r.BalancePaise),
        }));
    }

    private static IResult GetById(int id, IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();

        var customer = connection.QuerySingleOrDefault(
            """
            SELECT id AS Id, code AS Code, name AS Name, company_name AS CompanyName, phone AS Phone,
                   address AS Address, note AS Note, is_active AS IsActive
              FROM customer WHERE id = @id
            """, new { id });

        if (customer is null) return ApiResults.NotFound("Customer", id);

        // Named class, not a ValueTuple: Dapper binds tuples positionally.
        var rates = connection.Query<RateRow>(
            "SELECT product_id AS ProductId, rate_paise AS RatePaise FROM customer_product_rate WHERE customer_id = @id",
            new { id });

        var balance = connection.ExecuteScalar<long>(
            """
            SELECT COALESCE(SUM(balance_amount_paise), 0) FROM sale
             WHERE customer_id = @id AND is_void = 0 AND balance_amount_paise <> 0
            """, new { id });

        return Results.Ok(new
        {
            id = (int)customer.Id,
            code = (string)customer.Code,
            name = (string)customer.Name,
            companyName = (string)customer.CompanyName,
            phone = (string)customer.Phone,
            address = (string)customer.Address,
            note = (string)customer.Note,
            isActive = (long)customer.IsActive == 1,
            balance = Money.ToRupees(balance),
            rates = rates.ToDictionary(r => r.ProductId.ToString(), r => Money.ToRupees(r.RatePaise)),
        });
    }

    private static IResult Create(SaveCustomerRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory)
    {
        if (Validate(request) is { } problem) return problem;

        var user = principal.RequireUser();
        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var now = Clock.NowIso();

            // Code comes from number_sequence, allocated in this transaction.
            // The legacy generator was COUNT(*)+1, which produced six duplicate
            // codes in production and would collide again on any deletion.
            var code = SaleService.AllocateNumber(connection, transaction, "customer", now);

            var id = connection.ExecuteScalar<long>(
                """
                INSERT INTO customer (code, name, company_name, phone, address, note, is_active, created_by, created_at, updated_at)
                VALUES (@code, @name, @companyName, @phone, @address, '', @isActive, @userId, @now, @now);
                SELECT last_insert_rowid();
                """,
                new
                {
                    code,
                    name = request.Name.Trim(),
                    companyName = request.CompanyName?.Trim() ?? string.Empty,
                    phone = request.Phone?.Trim() ?? string.Empty,
                    address = request.Address?.Trim() ?? string.Empty,
                    isActive = request.IsActive ? 1 : 0,
                    userId = user.Id,
                    now,
                }, transaction);

            SaveRates(connection, transaction, (int)id, request.Rates, now);

            return Results.Created($"/api/customers/{id}", new { id = (int)id, code });
        });
    }

    private static IResult Update(int id, SaveCustomerRequest request, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory)
    {
        if (Validate(request) is { } problem) return problem;

        var user = principal.RequireUser();
        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var now = Clock.NowIso();
            var affected = connection.Execute(
                """
                UPDATE customer
                   SET name = @name, company_name = @companyName, phone = @phone,
                       address = @address, is_active = @isActive, updated_at = @now
                 WHERE id = @id
                """,
                new
                {
                    id,
                    name = request.Name.Trim(),
                    companyName = request.CompanyName?.Trim() ?? string.Empty,
                    phone = request.Phone?.Trim() ?? string.Empty,
                    address = request.Address?.Trim() ?? string.Empty,
                    isActive = request.IsActive ? 1 : 0,
                    now,
                }, transaction);

            if (affected == 0) return ApiResults.NotFound("Customer", id);

            // Rates are only changed by an administrator; an operator's payload
            // is ignored rather than rejected so the rest of the edit still saves.
            if (user.IsAdmin) SaveRates(connection, transaction, id, request.Rates, now);

            connection.Execute(
                """
                INSERT INTO audit_log (entity, entity_id, action, detail, user_id, created_at)
                VALUES ('customer', @id, 'UPDATE', '', @userId, @now)
                """, new { id, userId = user.Id, now }, transaction);

            return Results.NoContent();
        });
    }

    /// <summary>Sales and payments for one customer, newest first.</summary>
    private static IResult Ledger(int id, IDbConnectionFactory connectionFactory, string? from, string? to)
    {
        using var connection = connectionFactory.Open();

        var sales = connection.Query(
            """
            SELECT s.id AS Id, s.invoice_no AS Reference, s.sale_date AS EntryDate,
                   s.total_amount_paise AS TotalPaise, s.paid_amount_paise AS PaidPaise,
                   s.balance_amount_paise AS BalancePaise, s.is_void AS IsVoid
              FROM sale s
             WHERE s.customer_id = @id
               AND (@from IS NULL OR s.sale_date >= @from)
               AND (@to   IS NULL OR s.sale_date <= @to)
             ORDER BY s.sale_date DESC, s.id DESC
             LIMIT 500
            """, new { id, from, to });

        var payments = connection.Query(
            """
            SELECT p.id AS Id, p.payment_date AS EntryDate, p.amount_paise AS AmountPaise,
                   p.method AS Method, p.note AS Note
              FROM payment p
             WHERE p.customer_id = @id
               AND (@from IS NULL OR p.payment_date >= @from)
               AND (@to   IS NULL OR p.payment_date <= @to)
             ORDER BY p.payment_date DESC, p.id DESC
             LIMIT 500
            """, new { id, from, to });

        return Results.Ok(new
        {
            sales = sales.Select(s => new
            {
                id = (int)s.Id,
                reference = (string)s.Reference,
                entryDate = (string)s.EntryDate,
                total = Money.ToRupees((long)s.TotalPaise),
                paid = Money.ToRupees((long)s.PaidPaise),
                balance = Money.ToRupees((long)s.BalancePaise),
                isVoid = (long)s.IsVoid == 1,
            }),
            payments = payments.Select(p => new
            {
                id = (int)p.Id,
                entryDate = (string)p.EntryDate,
                amount = Money.ToRupees((long)p.AmountPaise),
                method = (string)p.Method,
                note = (string)p.Note,
            }),
        });
    }

    // ------------------------------------------------------------------ helpers

    private static void SaveRates(
        Microsoft.Data.Sqlite.SqliteConnection connection,
        Microsoft.Data.Sqlite.SqliteTransaction transaction,
        int customerId,
        List<CustomerRateInput>? rates,
        string now)
    {
        if (rates is null) return;

        // Replace wholesale: an absent product means "use the default rate",
        // which has to be expressible by removing the row.
        connection.Execute(
            "DELETE FROM customer_product_rate WHERE customer_id = @customerId",
            new { customerId }, transaction);

        foreach (var rate in rates.Where(r => r.Rate >= 0))
        {
            connection.Execute(
                """
                INSERT INTO customer_product_rate (customer_id, product_id, rate_paise, updated_at)
                VALUES (@customerId, @productId, @rate, @now)
                """,
                new { customerId, productId = rate.ProductId, rate = Money.FromRupees(rate.Rate), now },
                transaction);
        }
    }

    private static IResult? Validate(SaveCustomerRequest request)
    {
        var validator = new Validator()
            .RequireText(request.Name, "name", 255)
            .Require((request.CompanyName?.Length ?? 0) <= 255, "companyName", "Must be 255 characters or fewer.")
            .Require((request.Phone?.Length ?? 0) <= 40, "phone", "Must be 40 characters or fewer.");

        if (request.Rates is not null)
        {
            foreach (var rate in request.Rates)
            {
                if (rate.Rate < 0) validator.Add("rates", "A rate cannot be negative.");
                if (rate.Rate > 1_000_000) validator.Add("rates", "A rate is unreasonably large.");
            }
        }

        return validator.Problem();
    }

    private sealed class RateRow
    {
        public int ProductId { get; init; }
        public long RatePaise { get; init; }
    }
}

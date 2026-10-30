using System.Security.Claims;
using Dapper;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Payments;

public sealed record CreatePaymentRequest(
    string? ClientUuid,
    int CustomerId,
    string PaymentDate,
    decimal Amount,
    string? Method,
    string? Note);

/// <summary>
/// Money received against an outstanding balance, separate from a sale.
/// </summary>
/// <remarks>
/// The legacy application had no such concept: a settlement was recorded as a
/// sale of zero cans with a paid amount, and six of those came across in the
/// import (Rs 13,775 in total). Those rows are preserved exactly as they were,
/// but settlements recorded from here on are first-class.
/// </remarks>
public sealed class PaymentEndpoints : IEndpointModule
{
    private static readonly string[] AllowedMethods = ["CASH", "UPI", "BANK", "CHEQUE", "OTHER"];

    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/payments").WithTags("Payments").RequireAuthorization(Policies.SignedIn);

        group.MapGet("/", List);
        group.MapPost("/", Create);
    }

    private static IResult List(
        IDbConnectionFactory connectionFactory,
        string? search, string? from, string? to, int? customerId,
        int page = 1, int pageSize = 100)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 500);

        var filters = new List<string> { "1=1" };
        if (!string.IsNullOrWhiteSpace(from) && Clock.IsValidDate(from)) filters.Add("p.payment_date >= @from");
        if (!string.IsNullOrWhiteSpace(to) && Clock.IsValidDate(to)) filters.Add("p.payment_date <= @to");
        if (customerId is > 0) filters.Add("p.customer_id = @customerId");
        if (!string.IsNullOrWhiteSpace(search)) filters.Add("(c.name LIKE @search OR c.code LIKE @search)");

        var where = "WHERE " + string.Join(" AND ", filters);
        var parameters = new
        {
            from, to, customerId, search = $"%{search}%",
            limit = pageSize, offset = (page - 1) * pageSize,
        };

        using var connection = connectionFactory.Open();

        var total = connection.ExecuteScalar<int>(
            $"SELECT COUNT(*) FROM payment p JOIN customer c ON c.id = p.customer_id {where}", parameters);

        var rows = connection.Query(
            $"""
             SELECT p.id AS Id, p.customer_id AS CustomerId, c.code AS CustomerCode, c.name AS CustomerName,
                    p.payment_date AS PaymentDate, p.amount_paise AS AmountPaise, p.method AS Method,
                    p.note AS Note, u.display_name AS CreatedByName
               FROM payment p
               JOIN customer c ON c.id = p.customer_id
               LEFT JOIN app_user u ON u.id = p.created_by
               {where}
              ORDER BY p.payment_date DESC, p.id DESC
              LIMIT @limit OFFSET @offset
             """, parameters);

        return Results.Ok(new
        {
            total, page, pageSize,
            items = rows.Select(r => new
            {
                id = (int)r.Id,
                customerId = (int)r.CustomerId,
                customerCode = (string)r.CustomerCode,
                customerName = (string)r.CustomerName,
                paymentDate = (string)r.PaymentDate,
                amount = Money.ToRupees((long)r.AmountPaise),
                method = (string)r.Method,
                note = (string)r.Note,
                createdByName = (string?)r.CreatedByName,
            }),
        });
    }

    private static IResult Create(
        CreatePaymentRequest request,
        ClaimsPrincipal principal,
        IDbConnectionFactory connectionFactory,
        IClock clock)
    {
        var validator = new Validator()
            .RequirePositive(request.CustomerId, "customerId")
            .RequireDate(request.PaymentDate, "paymentDate")
            .Require(request.Amount > 0, "amount", "Must be greater than zero.")
            .RequireRange(request.Amount, 0, 10_000_000, "amount");

        if (Clock.IsValidDate(request.PaymentDate) &&
            string.CompareOrdinal(request.PaymentDate, clock.Today()) > 0)
        {
            validator.Add("paymentDate", "Cannot be in the future.");
        }

        var method = (request.Method ?? "CASH").ToUpperInvariant();
        if (!AllowedMethods.Contains(method)) validator.Add("method", "Not a recognised payment method.");

        if (validator.Problem() is { } problem) return problem;

        var user = principal.RequireUser();
        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            // Same idempotency contract as a sale, so a retried request cannot
            // credit a customer twice.
            if (!string.IsNullOrWhiteSpace(request.ClientUuid))
            {
                var existingId = connection.QuerySingleOrDefault<long?>(
                    "SELECT id FROM payment WHERE client_uuid = @uuid",
                    new { uuid = request.ClientUuid }, transaction);

                if (existingId is not null)
                {
                    return Results.Ok(new { id = (int)existingId.Value, wasDuplicate = true });
                }
            }

            var customerExists = connection.ExecuteScalar<int>(
                "SELECT COUNT(*) FROM customer WHERE id = @id", new { id = request.CustomerId }, transaction);
            if (customerExists == 0) return ApiResults.NotFound("Customer", request.CustomerId);

            var now = Clock.NowIso();
            var id = connection.ExecuteScalar<long>(
                """
                INSERT INTO payment (customer_id, sale_id, payment_date, amount_paise, method, note, client_uuid, created_by, created_at)
                VALUES (@customerId, NULL, @paymentDate, @amount, @method, @note, @uuid, @userId, @now);
                SELECT last_insert_rowid();
                """,
                new
                {
                    customerId = request.CustomerId,
                    paymentDate = request.PaymentDate,
                    amount = Money.FromRupees(request.Amount),
                    method,
                    note = request.Note ?? string.Empty,
                    uuid = string.IsNullOrWhiteSpace(request.ClientUuid) ? null : request.ClientUuid,
                    userId = user.Id,
                    now,
                }, transaction);

            // A payment reduces what the customer owes. Balances are derived from
            // sale.balance_amount_paise, so the receipt is applied against the
            // oldest unpaid sales first - the order a customer would expect, and
            // it keeps a single source of truth for the outstanding figure.
            var remaining = Money.FromRupees(request.Amount);
            // Named class, not a ValueTuple: Dapper binds tuples positionally,
            // and getting these four columns out of order would misapply money.
            var openSales = connection.Query<OpenSale>(
                """
                SELECT id AS Id, balance_amount_paise AS BalancePaise,
                       paid_amount_paise AS PaidPaise, total_amount_paise AS TotalPaise
                  FROM sale
                 WHERE customer_id = @customerId AND is_void = 0 AND balance_amount_paise > 0
                 ORDER BY sale_date, id
                """, new { customerId = request.CustomerId }, transaction).ToList();

            foreach (var sale in openSales)
            {
                if (remaining <= 0) break;
                var applied = Math.Min(remaining, sale.BalancePaise);
                var newPaid = sale.PaidPaise + applied;
                var newBalance = sale.TotalPaise - newPaid;

                connection.Execute(
                    """
                    UPDATE sale
                       SET paid_amount_paise = @paid, balance_amount_paise = @balance,
                           payment_status = @status, updated_at = @now
                     WHERE id = @id
                    """,
                    new
                    {
                        paid = newPaid,
                        balance = newBalance,
                        status = newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIAL" : "UNPAID",
                        now,
                        id = sale.Id,
                    }, transaction);

                remaining -= applied;
            }

            connection.Execute(
                """
                INSERT INTO audit_log (entity, entity_id, action, detail, user_id, created_at)
                VALUES ('payment', @id, 'CREATE', @detail, @userId, @now)
                """,
                new
                {
                    id,
                    detail = remaining > 0
                        ? $"{Money.Format(remaining)} left unapplied as credit"
                        : string.Empty,
                    userId = user.Id,
                    now,
                }, transaction);

            return Results.Ok(new
            {
                id = (int)id,
                wasDuplicate = false,
                // Anything beyond what was owed stays as customer credit rather
                // than being silently dropped.
                unappliedCredit = Money.ToRupees(remaining),
            });
        });
    }

    private sealed class OpenSale
    {
        public long Id { get; init; }
        public long BalancePaise { get; init; }
        public long PaidPaise { get; init; }
        public long TotalPaise { get; init; }
    }
}

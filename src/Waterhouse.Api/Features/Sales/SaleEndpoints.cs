using System.Security.Claims;
using Dapper;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Sales;

public sealed record SaleLineRequest(int ProductId, int Quantity, decimal Rate, int? CapProductId = null);

public sealed record CreateSaleRequest(
    string? ClientUuid,
    string SaleDate,
    /// <summary>Omit or null for a local walk-in sale.</summary>
    int? CustomerId,
    bool IsLocal,
    List<SaleLineRequest> Lines,
    decimal PaidAmount,
    string? PaymentMethod,
    string? Note);

public sealed record SaleResponse(
    int Id, string InvoiceNo, string SaleDate,
    int? CustomerId, string CustomerCode, string CustomerName, bool IsLocal,
    decimal TotalAmount, decimal PaidAmount, decimal BalanceAmount,
    string PaymentStatus, string PaymentMethod,
    bool IsVoid, string Note, string? CreatedByName, string CreatedAt,
    List<SaleLineResponse> Lines);

public sealed record SaleLineResponse(
    int ProductId, string ProductCode, string ProductName, int Quantity, decimal Rate, decimal Amount,
    int? CapProductId, string? CapName);

public sealed record CreateSaleResponse(
    int Id, string InvoiceNo, string SaleDate, decimal TotalAmount, decimal PaidAmount,
    decimal BalanceAmount, string PaymentStatus, decimal CustomerBalanceAfter,
    bool WasDuplicate, List<string> Warnings);

/// <summary>Shown on a local sale wherever a customer name would otherwise go.</summary>
internal static class LocalSale
{
    public const string DisplayName = "Local / Walk-in";
    public const string DisplayCode = "LOCAL";
}

internal sealed class FilteredTotals
{
    public long Quantity { get; init; }
    public long TotalPaise { get; init; }
    public long PaidPaise { get; init; }
    public long BalancePaise { get; init; }
}

public sealed record VoidSaleRequest(string Reason);

public sealed class SaleEndpoints : IEndpointModule
{
    public void RegisterServices(IServiceCollection services) => services.AddSingleton<SaleService>();

    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/sales").WithTags("Sales").RequireAuthorization(Policies.SignedIn);

        group.MapPost("/", Create);
        group.MapPost("/batch", CreateBatch);
        group.MapGet("/", List);
        group.MapGet("/{id:int}", GetById);
        group.MapPut("/{id:int}", Update).RequireAuthorization(Policies.AdminOnly);
        group.MapPost("/{id:int}/void", Void).RequireAuthorization(Policies.AdminOnly);
    }

    private static IResult Create(CreateSaleRequest request, ClaimsPrincipal principal, SaleService sales, IClock clock)
    {
        if (Validate(request, clock, sales.ActiveCapProductIds()) is { } problem) return problem;

        var result = sales.Create(ToInput(request), principal.RequireUser());
        return Results.Ok(ToResponse(request.SaleDate, result));
    }

    /// <summary>
    /// Accept many sales in one request - the offline outbox flushing after the
    /// connection returns.
    /// </summary>
    /// <remarks>
    /// Each sale commits in its own transaction, so one bad entry cannot discard
    /// a whole shift's queued takings. The response reports per-item outcomes and
    /// the endpoint returns 200 even when some items failed; the client keeps the
    /// failures in its outbox and surfaces them.
    /// </remarks>
    private static IResult CreateBatch(List<CreateSaleRequest> requests, ClaimsPrincipal principal, SaleService sales, IClock clock, ILoggerFactory loggerFactory)
    {
        if (requests.Count == 0) return Results.Ok(new { accepted = 0, failed = 0, results = Array.Empty<object>() });
        if (requests.Count > 500)
        {
            return ApiResults.Unprocessable("A batch may contain at most 500 sales. Send them in smaller groups.");
        }

        var logger = loggerFactory.CreateLogger("SaleBatch");
        var user = principal.RequireUser();
        var results = new List<object>(requests.Count);
        int accepted = 0, failed = 0;

        // Fetched once for the whole batch rather than per item.
        var capIds = sales.ActiveCapProductIds();

        foreach (var request in requests)
        {
            if (Validate(request, clock, capIds) is not null)
            {
                failed++;
                results.Add(new { clientUuid = request.ClientUuid, ok = false, error = "Validation failed." });
                continue;
            }
            try
            {
                var result = sales.Create(ToInput(request), user);
                accepted++;
                results.Add(new { clientUuid = request.ClientUuid, ok = true, sale = ToResponse(request.SaleDate, result) });
            }
            catch (Exception ex)
            {
                failed++;
                logger.LogError(ex, "Batch sale {ClientUuid} failed", request.ClientUuid);
                results.Add(new { clientUuid = request.ClientUuid, ok = false, error = "Could not be recorded." });
            }
        }

        return Results.Ok(new { accepted, failed, results });
    }

    private static IResult List(
        IDbConnectionFactory connectionFactory,
        string? search, string? from, string? to, int? customerId, string? status,
        string? customerType, string? paymentMethod,
        int page = 1, int pageSize = 50, bool includeVoid = false)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 200);

        // Built per table alias so the same predicates can be reused verbatim in
        // the totals query, which needs its own alias. Generating one string and
        // string-replacing the alias into another would break the moment a
        // filter mentioned a column containing the alias text.
        string BuildWhere(string sale, string customer)
        {
            var filters = new List<string> { includeVoid ? "1=1" : $"{sale}.is_void = 0" };
            if (!string.IsNullOrWhiteSpace(from) && Clock.IsValidDate(from)) filters.Add($"{sale}.sale_date >= @from");
            if (!string.IsNullOrWhiteSpace(to) && Clock.IsValidDate(to)) filters.Add($"{sale}.sale_date <= @to");
            if (customerId is > 0) filters.Add($"{sale}.customer_id = @customerId");
            if (!string.IsNullOrWhiteSpace(status)) filters.Add($"{sale}.payment_status = @status");
            if (!string.IsNullOrWhiteSpace(paymentMethod)) filters.Add($"{sale}.payment_method = @paymentMethod");

            // registered | local | (anything else) = both
            if (string.Equals(customerType, "local", StringComparison.OrdinalIgnoreCase)) filters.Add($"{sale}.is_local = 1");
            else if (string.Equals(customerType, "registered", StringComparison.OrdinalIgnoreCase)) filters.Add($"{sale}.is_local = 0");

            // A local sale has no customer row, so it can only be matched by invoice.
            if (!string.IsNullOrWhiteSpace(search))
            {
                filters.Add($"({customer}.name LIKE @search OR {customer}.code LIKE @search OR {sale}.invoice_no LIKE @search)");
            }

            return "WHERE " + string.Join(" AND ", filters);
        }

        var where = BuildWhere("s", "c");
        var parameters = new
        {
            from, to, customerId, status = status?.ToUpperInvariant(),
            paymentMethod = paymentMethod?.ToUpperInvariant(),
            search = $"%{search}%", limit = pageSize, offset = (page - 1) * pageSize,
        };

        using var connection = connectionFactory.Open();

        // LEFT JOIN, not JOIN: a local sale has customer_id NULL and an inner
        // join would drop every walk-in from the list and the count.
        var total = connection.ExecuteScalar<int>(
            $"SELECT COUNT(*) FROM sale s LEFT JOIN customer c ON c.id = s.customer_id {where}", parameters);

        var rows = connection.Query(
            $"""
             SELECT s.id AS Id, s.invoice_no AS InvoiceNo, s.sale_date AS SaleDate,
                    s.customer_id AS CustomerId, c.code AS CustomerCode, c.name AS CustomerName,
                    s.is_local AS IsLocal,
                    s.total_amount_paise AS TotalPaise, s.paid_amount_paise AS PaidPaise,
                    s.balance_amount_paise AS BalancePaise, s.payment_status AS PaymentStatus,
                    s.payment_method AS PaymentMethod, s.is_void AS IsVoid,
                    s.note AS Note, s.created_at AS CreatedAt, u.display_name AS CreatedByName,
                    (SELECT COALESCE(SUM(quantity),0) FROM sale_line WHERE sale_id = s.id) AS Quantity,
                    -- Products and caps on the bill, so the list shows what was
                    -- actually sold without a round-trip per row.
                    (SELECT GROUP_CONCAT(p.name, ', ') FROM sale_line l
                      JOIN product p ON p.id = l.product_id WHERE l.sale_id = s.id) AS Products,
                    (SELECT GROUP_CONCAT(cp.name, ', ') FROM sale_line l
                      JOIN product cp ON cp.id = l.cap_product_id WHERE l.sale_id = s.id) AS Caps
               FROM sale s
               LEFT JOIN customer c ON c.id = s.customer_id
               LEFT JOIN app_user u ON u.id = s.created_by
               {where}
              ORDER BY s.sale_date DESC, s.id DESC
              LIMIT @limit OFFSET @offset
             """, parameters);

        var items = rows.Select(r =>
        {
            var isLocal = (long)r.IsLocal == 1;
            return new
            {
                id = (int)r.Id,
                invoiceNo = (string)r.InvoiceNo,
                saleDate = (string)r.SaleDate,
                customerId = (int?)r.CustomerId,
                customerCode = isLocal ? LocalSale.DisplayCode : (string?)r.CustomerCode ?? string.Empty,
                customerName = isLocal ? LocalSale.DisplayName : (string?)r.CustomerName ?? string.Empty,
                isLocal,
                quantity = (long)r.Quantity,
                products = (string?)r.Products ?? string.Empty,
                caps = (string?)r.Caps ?? string.Empty,
                totalAmount = Money.ToRupees((long)r.TotalPaise),
                paidAmount = Money.ToRupees((long)r.PaidPaise),
                balanceAmount = Money.ToRupees((long)r.BalancePaise),
                paymentStatus = (string)r.PaymentStatus,
                paymentMethod = (string)r.PaymentMethod,
                isVoid = (long)r.IsVoid == 1,
                note = (string)r.Note,
                createdAt = (string)r.CreatedAt,
                createdByName = (string?)r.CreatedByName,
            };
        }).ToList();

        // Totals for the whole filtered set, not just this page - a filtered
        // view is nearly always a question about money, and paging through to
        // add it up by hand defeats the point.
        var sums = connection.QuerySingle<FilteredTotals>(
            $"""
             SELECT COALESCE(SUM(s.total_amount_paise),0)   AS TotalPaise,
                    COALESCE(SUM(s.paid_amount_paise),0)    AS PaidPaise,
                    COALESCE(SUM(s.balance_amount_paise),0) AS BalancePaise,
                    COALESCE((SELECT SUM(l.quantity)
                                FROM sale_line l
                                JOIN sale t ON t.id = l.sale_id
                                LEFT JOIN customer tc ON tc.id = t.customer_id
                               {BuildWhere("t", "tc")}), 0) AS Quantity
               FROM sale s LEFT JOIN customer c ON c.id = s.customer_id
               {where}
             """, parameters);

        return Results.Ok(new
        {
            total, page, pageSize, items,
            totals = new
            {
                quantity = sums.Quantity,
                totalAmount = Money.ToRupees(sums.TotalPaise),
                paidAmount = Money.ToRupees(sums.PaidPaise),
                balanceAmount = Money.ToRupees(sums.BalancePaise),
            },
        });
    }

    private static IResult GetById(int id, IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();

        // LEFT JOIN so a local sale (customer_id NULL) is still found.
        var sale = connection.QuerySingleOrDefault(
            """
            SELECT s.id AS Id, s.invoice_no AS InvoiceNo, s.sale_date AS SaleDate,
                   s.customer_id AS CustomerId, c.code AS CustomerCode, c.name AS CustomerName,
                   s.is_local AS IsLocal,
                   s.total_amount_paise AS TotalPaise, s.paid_amount_paise AS PaidPaise,
                   s.balance_amount_paise AS BalancePaise, s.payment_status AS PaymentStatus,
                   s.payment_method AS PaymentMethod,
                   s.is_void AS IsVoid, s.note AS Note, s.created_at AS CreatedAt,
                   u.display_name AS CreatedByName
              FROM sale s
              LEFT JOIN customer c ON c.id = s.customer_id
              LEFT JOIN app_user u ON u.id = s.created_by
             WHERE s.id = @id
            """, new { id });

        if (sale is null) return ApiResults.NotFound("Sale", id);

        var lines = connection.Query(
            """
            SELECT l.product_id AS ProductId, p.code AS ProductCode, p.name AS ProductName,
                   l.quantity AS Quantity, l.rate_paise AS RatePaise, l.amount_paise AS AmountPaise,
                   l.cap_product_id AS CapProductId, cap.name AS CapName
              FROM sale_line l
              JOIN product p ON p.id = l.product_id
              LEFT JOIN product cap ON cap.id = l.cap_product_id
             WHERE l.sale_id = @id ORDER BY l.id
            """, new { id })
            .Select(l => new SaleLineResponse(
                (int)l.ProductId, (string)l.ProductCode, (string)l.ProductName,
                (int)l.Quantity, Money.ToRupees((long)l.RatePaise), Money.ToRupees((long)l.AmountPaise),
                (int?)l.CapProductId, (string?)l.CapName))
            .ToList();

        var detailIsLocal = (long)sale.IsLocal == 1;

        return Results.Ok(new SaleResponse(
            (int)sale.Id, (string)sale.InvoiceNo, (string)sale.SaleDate,
            (int?)sale.CustomerId,
            detailIsLocal ? LocalSale.DisplayCode : (string?)sale.CustomerCode ?? string.Empty,
            detailIsLocal ? LocalSale.DisplayName : (string?)sale.CustomerName ?? string.Empty,
            detailIsLocal,
            Money.ToRupees((long)sale.TotalPaise), Money.ToRupees((long)sale.PaidPaise),
            Money.ToRupees((long)sale.BalancePaise), (string)sale.PaymentStatus, (string)sale.PaymentMethod,
            (long)sale.IsVoid == 1, (string)sale.Note, (string?)sale.CreatedByName, (string)sale.CreatedAt,
            lines));
    }

    /// <summary>
    /// Correct a recorded sale. Admin only; the invoice number is kept and the
    /// change is written to the audit log.
    /// </summary>
    private static IResult Update(
        int id, CreateSaleRequest request, ClaimsPrincipal principal, SaleService sales, IClock clock)
    {
        // Same rules as creating one - a correction must not be able to produce
        // a sale that could not have been entered in the first place.
        if (Validate(request, clock, sales.ActiveCapProductIds()) is { } problem) return problem;

        var outcome = sales.Update(id, ToInput(request), principal.RequireUser());

        return outcome.Status switch
        {
            UpdateSaleStatus.NotFound => ApiResults.NotFound("Sale", id),
            UpdateSaleStatus.Voided => ApiResults.Unprocessable(
                "That sale is voided and cannot be edited. Enter a new sale instead."),
            _ => Results.Ok(ToResponse(request.SaleDate, outcome.Result!)),
        };
    }

    private static IResult Void(int id, VoidSaleRequest request, ClaimsPrincipal principal, SaleService sales)
    {
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            return new Validator().Add("reason", "A reason is required to void a sale.").Problem()!;
        }

        return sales.Void(id, request.Reason.Trim(), principal.RequireUser())
            ? Results.NoContent()
            : ApiResults.Unprocessable("That sale does not exist or has already been voided.");
    }

    // ------------------------------------------------------------------ helpers

    private static IResult? Validate(CreateSaleRequest request, IClock clock, HashSet<int> validCapProductIds)
    {
        var validator = new Validator()
            .RequireDate(request.SaleDate, "saleDate")
            .Require(request.Lines is { Count: > 0 }, "lines", "At least one line is required.")
            .Require(request.PaidAmount >= 0, "paidAmount", "Cannot be negative.");

        // Exactly one of the two shapes. Mirrors the ck_sale_local_has_no_customer
        // constraint so a bad request is a 400 rather than a constraint violation.
        if (request.IsLocal)
        {
            validator.Require(request.CustomerId is null or 0, "customerId",
                "A local walk-in sale must not name a customer.");
        }
        else
        {
            validator.Require(request.CustomerId is > 0, "customerId",
                "Select a customer, or mark the sale as local.");
        }

        if (!string.IsNullOrWhiteSpace(request.PaymentMethod) &&
            !SaleService.PaymentMethods.Contains(request.PaymentMethod.Trim().ToUpperInvariant()))
        {
            validator.Add("paymentMethod",
                $"Must be one of: {string.Join(", ", SaleService.PaymentMethods)}.");
        }

        // A sale dated in the future is almost always a mistyped date, and it
        // would silently distort every daily and monthly report.
        if (Clock.IsValidDate(request.SaleDate) && string.CompareOrdinal(request.SaleDate, clock.Today()) > 0)
        {
            validator.Add("saleDate", "Cannot be in the future.");
        }

        if (request.Lines is { Count: > 0 })
        {
            for (var i = 0; i < request.Lines.Count; i++)
            {
                var line = request.Lines[i];
                validator
                    .RequirePositive(line.ProductId, $"lines[{i}].productId")
                    .RequirePositive(line.Quantity, $"lines[{i}].quantity")
                    .Require(line.Rate >= 0, $"lines[{i}].rate", "Cannot be negative.")
                    .RequireRange(line.Rate, 0, 1_000_000, $"lines[{i}].rate");

                // A cap must be a giveaway stock item. Without this the foreign
                // key would happily accept a water can as the "cap" and then
                // decrement can stock.
                if (line.CapProductId is > 0 && !validCapProductIds.Contains(line.CapProductId.Value))
                {
                    validator.Add($"lines[{i}].capProductId", "Not a valid cap.");
                }
            }
        }

        return validator.Problem();
    }

    private static CreateSaleInput ToInput(CreateSaleRequest request) => new(
        request.ClientUuid,
        request.SaleDate,
        request.IsLocal ? null : request.CustomerId,
        request.IsLocal,
        request.Lines
            .Select(l => new SaleLineInput(
                l.ProductId, l.Quantity, l.Rate,
                l.CapProductId is > 0 ? l.CapProductId : null))
            .ToList(),
        request.PaidAmount,
        request.PaymentMethod,
        request.Note);

    private static CreateSaleResponse ToResponse(string saleDate, CreateSaleResult result) => new(
        result.SaleId, result.InvoiceNo, saleDate,
        Money.ToRupees(result.TotalPaise), Money.ToRupees(result.PaidPaise), Money.ToRupees(result.BalancePaise),
        result.PaymentStatus, Money.ToRupees(result.CustomerBalanceAfterPaise),
        result.WasDuplicate, result.Warnings.ToList());
}

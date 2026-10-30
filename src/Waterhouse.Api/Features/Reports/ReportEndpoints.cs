using Dapper;
using Waterhouse.Api.Features.Sales;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Reports;

/// <summary>
/// Two parameterised endpoints replacing fourteen legacy report actions.
/// </summary>
/// <remarks>
/// The legacy ReportController was 912 lines. It had a separate action and Blade
/// view for can daily/monthly/yearly/date-range, customer monthly/yearly/
/// date-range and expense daily/monthly/yearly - each duplicated again as an
/// AJAX twin, and each assembling its HTML with string concatenation inside a
/// foreach loop.
///
/// Every one of those is the same aggregate over a date window with a different
/// GROUP BY, so they collapse into this. Combinations the old app could not
/// express - bag sales by customer for a quarter - now come for free.
///
/// The GROUP BY expression is chosen from a fixed allow-list and never
/// interpolated from user input; every value is a bound parameter.
/// </remarks>
public sealed class ReportEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/reports").WithTags("Reports").RequireAuthorization(Policies.SignedIn);

        group.MapGet("/sales", SalesReport);
        group.MapGet("/expenses", ExpenseReport);
        group.MapGet("/outstanding", Outstanding);
    }

    private static IResult SalesReport(
        IDbConnectionFactory connectionFactory,
        string? groupBy, string? from, string? to, int? productId, int? customerId,
        string? customerType, string? paymentMethod)
    {
        if (!Clock.IsValidDate(from) || !Clock.IsValidDate(to))
        {
            return new Validator().Add("from", "A valid from and to date are required.").Problem()!;
        }

        // registered | local | anything else = both. Kept out of the SQL text as
        // a bound-parameter-driven predicate rather than string interpolation.
        var localFilter = (customerType ?? string.Empty).ToLowerInvariant() switch
        {
            "local" => " AND s.is_local = 1",
            "registered" => " AND s.is_local = 0",
            _ => string.Empty,
        };

        // Chosen from the fixed allow-list, so nothing from the query string
        // reaches the SQL text even though the value is compared literally.
        var method = string.IsNullOrWhiteSpace(paymentMethod)
            ? null
            : SaleService.PaymentMethods.FirstOrDefault(
                m => m.Equals(paymentMethod.Trim(), StringComparison.OrdinalIgnoreCase));
        var methodFilter = method is null ? string.Empty : " AND s.payment_method = @paymentMethodValue";

        using var connection = connectionFactory.Open();

        // Grouping by product is a genuinely different shape and gets its own
        // query. Paid and balance live on the sale header and cannot be split
        // across the products on a bill, so this variant reports the line amount
        // and leaves the settlement columns at zero rather than inventing a
        // per-product apportionment.
        if (groupBy == "product")
        {
            var productRows = connection.Query(
                $"""
                SELECT l.product_id                      AS GroupKey,
                       p.name                            AS Label,
                       COUNT(DISTINCT s.id)              AS SaleCount,
                       COALESCE(SUM(l.quantity), 0)      AS Quantity,
                       COALESCE(SUM(l.amount_paise), 0)  AS TotalPaise,
                       0                                 AS PaidPaise,
                       0                                 AS BalancePaise
                  FROM sale_line l
                  JOIN sale s    ON s.id = l.sale_id
                  JOIN product p ON p.id = l.product_id
                 WHERE s.is_void = 0
                   AND s.sale_date BETWEEN @from AND @to
                   AND (@customerId IS NULL OR s.customer_id = @customerId)
                   AND (@productId  IS NULL OR l.product_id  = @productId)
                   {localFilter}{methodFilter}
                 GROUP BY l.product_id
                 ORDER BY Quantity DESC
                """,
                new
                {
                    from, to,
                    customerId = customerId > 0 ? customerId : null,
                    productId = productId > 0 ? productId : null,
                    paymentMethodValue = method,
                });

            return Results.Ok(new { rows = Project(productRows) });
        }

        // "Registered vs local" as its own two-row grouping - the split the
        // counter actually cares about, and the one the legacy app could only
        // approximate with a hard-coded customer-id list.
        if (groupBy == "customerType")
        {
            // $""" - interpolated. Without the $ the {methodFilter} placeholder
            // is sent to SQLite as literal text and the query fails.
            var splitRows = connection.Query(
                $"""
                SELECT s.is_local AS GroupKey,
                       CASE WHEN s.is_local = 1 THEN 'Local / Walk-in' ELSE 'Registered customers' END AS Label,
                       COUNT(*)                                  AS SaleCount,
                       COALESCE(SUM(q.quantity), 0)              AS Quantity,
                       COALESCE(SUM(s.total_amount_paise), 0)    AS TotalPaise,
                       COALESCE(SUM(s.paid_amount_paise), 0)     AS PaidPaise,
                       COALESCE(SUM(s.balance_amount_paise), 0)  AS BalancePaise
                  FROM sale s
                  LEFT JOIN (
                        SELECT l.sale_id, SUM(l.quantity) AS quantity
                          FROM sale_line l
                          JOIN sale s2 ON s2.id = l.sale_id
                         WHERE s2.sale_date BETWEEN @from AND @to
                           AND (@productId IS NULL OR l.product_id = @productId)
                         GROUP BY l.sale_id
                       ) q ON q.sale_id = s.id
                 WHERE s.is_void = 0 AND s.sale_date BETWEEN @from AND @to{methodFilter}
                 GROUP BY s.is_local
                 ORDER BY s.is_local
                """,
                new { from, to, productId = productId > 0 ? productId : null, paymentMethodValue = method });

            return Results.Ok(new { rows = Project(splitRows) });
        }

        // Fixed allow-list: nothing from the query string reaches the SQL text.
        //
        // Grouping by customer folds every walk-in into one "Local / Walk-in"
        // row: a local sale has customer_id NULL, so COALESCE gives them a
        // single stable key instead of dropping them.
        var (groupExpression, labelExpression, needsCustomerJoin) = (groupBy ?? "day") switch
        {
            "day"      => ("s.sale_date", "s.sale_date", false),
            "month"    => ("substr(s.sale_date, 1, 7)", "substr(s.sale_date, 1, 7)", false),
            "year"     => ("substr(s.sale_date, 1, 4)", "substr(s.sale_date, 1, 4)", false),
            "customer" => ("COALESCE(s.customer_id, -1)",
                           "COALESCE(c.name || ' (' || c.code || ')', 'Local / Walk-in')", true),
            _          => ("s.sale_date", "s.sale_date", false),
        };

        // Money is aggregated at the SALE level, never through a join to
        // sale_line: a bill with two lines would otherwise contribute its total
        // twice. Quantity therefore arrives pre-aggregated per sale from a
        // subquery, which keeps exactly one row per sale.
        //
        // The join to that subquery is LEFT so the 755 imported line-less rows
        // survive - six of them carry a payment, and dropping them would lose
        // Rs 13,775 from every total.
        var filters = new List<string> { "s.is_void = 0", "s.sale_date BETWEEN @from AND @to" };
        if (customerId is > 0) filters.Add("s.customer_id = @customerId");
        // Filtering by product restricts which SALES are counted; the money
        // reported stays the whole bill, because that is what was billed.
        if (productId is > 0) filters.Add("q.quantity IS NOT NULL");

        var sql = $"""
            SELECT {groupExpression} AS GroupKey,
                   {labelExpression} AS Label,
                   COUNT(*)                                  AS SaleCount,
                   COALESCE(SUM(q.quantity), 0)              AS Quantity,
                   COALESCE(SUM(s.total_amount_paise), 0)    AS TotalPaise,
                   COALESCE(SUM(s.paid_amount_paise), 0)     AS PaidPaise,
                   COALESCE(SUM(s.balance_amount_paise), 0)  AS BalancePaise
              FROM sale s
              LEFT JOIN (
                    -- The date window is repeated here on purpose. Without it
                    -- this subquery aggregates every sale_line row before the
                    -- outer WHERE narrows the range, which costs ~125 ms on
                    -- 112k lines regardless of how short the report period is.
                    SELECT l.sale_id, SUM(l.quantity) AS quantity
                      FROM sale_line l
                      JOIN sale s2 ON s2.id = l.sale_id
                     WHERE s2.sale_date BETWEEN @from AND @to
                       AND (@productId IS NULL OR l.product_id = @productId)
                     GROUP BY l.sale_id
                   ) q ON q.sale_id = s.id
              {(needsCustomerJoin ? "LEFT JOIN customer c ON c.id = s.customer_id" : string.Empty)}
             WHERE {string.Join(" AND ", filters)}{localFilter}{methodFilter}
             GROUP BY {groupExpression}
             ORDER BY {(groupBy == "customer" ? "Quantity DESC" : "GroupKey")}
            """;

        var rows = connection.Query(sql, new
        {
            from, to,
            customerId = customerId > 0 ? customerId : null,
            productId = productId > 0 ? productId : null,
            paymentMethodValue = method,
        });

        return Results.Ok(new { rows = Project(rows) });
    }

    private static IEnumerable<object> Project(IEnumerable<dynamic> rows) =>
        rows.Select(r => new
        {
            key = Convert.ToString(r.GroupKey) ?? string.Empty,
            label = Convert.ToString(r.Label) ?? string.Empty,
            saleCount = Convert.ToInt64(r.SaleCount),
            quantity = Convert.ToInt64(r.Quantity),
            total = Money.ToRupees(Convert.ToInt64(r.TotalPaise)),
            paid = Money.ToRupees(Convert.ToInt64(r.PaidPaise)),
            balance = Money.ToRupees(Convert.ToInt64(r.BalancePaise)),
        }).ToList();

    private static IResult ExpenseReport(
        IDbConnectionFactory connectionFactory, string? groupBy, string? from, string? to)
    {
        if (!Clock.IsValidDate(from) || !Clock.IsValidDate(to))
        {
            return new Validator().Add("from", "A valid from and to date are required.").Problem()!;
        }

        var (groupExpression, labelExpression, needsCategoryJoin) = (groupBy ?? "day") switch
        {
            "day"      => ("e.expense_date", "e.expense_date", false),
            "month"    => ("substr(e.expense_date, 1, 7)", "substr(e.expense_date, 1, 7)", false),
            "year"     => ("substr(e.expense_date, 1, 4)", "substr(e.expense_date, 1, 4)", false),
            "category" => ("e.category_id", "COALESCE(c.name, 'Uncategorised')", true),
            _          => ("e.expense_date", "e.expense_date", false),
        };

        var sql = $"""
            SELECT {groupExpression} AS GroupKey,
                   {labelExpression} AS Label,
                   COUNT(*) AS EntryCount,
                   COALESCE(SUM(e.amount_paise), 0) AS AmountPaise
              FROM expense e
              {(needsCategoryJoin ? "LEFT JOIN expense_category c ON c.id = e.category_id" : string.Empty)}
             WHERE e.expense_date BETWEEN @from AND @to
             GROUP BY {groupExpression}
             ORDER BY {(groupBy == "category" ? "AmountPaise DESC" : "GroupKey")}
            """;

        using var connection = connectionFactory.Open();
        var rows = connection.Query(sql, new { from, to });

        return Results.Ok(new
        {
            rows = rows.Select(r => new
            {
                key = Convert.ToString(r.GroupKey) ?? string.Empty,
                label = Convert.ToString(r.Label) ?? string.Empty,
                entryCount = (long)r.EntryCount,
                amount = Money.ToRupees((long)r.AmountPaise),
            }),
        });
    }

    /// <summary>Every customer who currently owes money, largest first.</summary>
    private static IResult Outstanding(IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();

        var rows = connection.Query(
            """
            SELECT c.id AS CustomerId, c.code AS Code, c.name AS Name, c.phone AS Phone,
                   SUM(s.balance_amount_paise) AS BalancePaise,
                   MAX(s.sale_date) AS LastSaleDate
              FROM sale s JOIN customer c ON c.id = s.customer_id
             WHERE s.is_void = 0 AND s.balance_amount_paise <> 0
             GROUP BY c.id
            HAVING SUM(s.balance_amount_paise) <> 0
             ORDER BY BalancePaise DESC
            """);

        return Results.Ok(new
        {
            rows = rows.Select(r => new
            {
                customerId = (int)r.CustomerId,
                code = (string)r.Code,
                name = (string)r.Name,
                phone = (string)r.Phone,
                balance = Money.ToRupees((long)r.BalancePaise),
                lastSaleDate = (string?)r.LastSaleDate,
            }),
        });
    }
}

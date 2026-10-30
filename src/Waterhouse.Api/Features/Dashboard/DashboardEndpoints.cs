using Dapper;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;

namespace Waterhouse.Api.Features.Dashboard;

/// <summary>
/// The owner's overview. Every figure the legacy dashboard showed, plus the
/// stock and outstanding positions it could not compute correctly.
/// </summary>
public sealed class DashboardEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/dashboard", Get)
            .WithTags("Dashboard")
            .RequireAuthorization(Policies.SignedIn);
    }

    private static IResult Get(IDbConnectionFactory connectionFactory, IClock clock, string? paymentMethod)
    {
        using var connection = connectionFactory.Open();

        // Resolved against the fixed allow-list, so the value appended to the
        // SQL text can only ever be one of six known literals.
        var method = string.IsNullOrWhiteSpace(paymentMethod)
            ? null
            : Features.Sales.SaleService.PaymentMethods.FirstOrDefault(
                m => m.Equals(paymentMethod.Trim(), StringComparison.OrdinalIgnoreCase));

        var saleMethodFilter = method is null ? string.Empty : " AND payment_method = @method";
        var paymentMethodFilter = method is null ? string.Empty : " AND method = @method";

        var today = clock.Today();
        var monthStart = today[..8] + "01";
        var previousMonthStart = PreviousMonthStart(monthStart);
        var previousMonthEnd = AddDays(monthStart, -1);
        var yearStart = today[..4] + "-01-01";

        var todayTotals = connection.QuerySingle<PeriodTotals>(
            $"""
            SELECT COUNT(*) AS SaleCount,
                   COALESCE((SELECT SUM(l.quantity) FROM sale_line l JOIN sale s2 ON s2.id = l.sale_id
                              WHERE s2.sale_date = @date AND s2.is_void = 0
                                {(method is null ? "" : "AND s2.payment_method = @method")}), 0) AS Quantity,
                   COALESCE(SUM(total_amount_paise), 0)   AS TotalPaise,
                   COALESCE(SUM(paid_amount_paise), 0)    AS PaidPaise,
                   COALESCE(SUM(balance_amount_paise), 0) AS BalancePaise
              FROM sale WHERE sale_date = @date AND is_void = 0{saleMethodFilter}
            """, new { date = today, method });

        var currentMonth = PeriodSummary(connection, monthStart, today, method);
        var previousMonth = PeriodSummary(connection, previousMonthStart, previousMonthEnd, method);

        var currentMonthExpenses = connection.ExecuteScalar<long>(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM expense WHERE expense_date BETWEEN @from AND @to",
            new { from = monthStart, to = today });

        var previousMonthExpenses = connection.ExecuteScalar<long>(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM expense WHERE expense_date BETWEEN @from AND @to",
            new { from = previousMonthStart, to = previousMonthEnd });

        // ---- payments received (separate from money taken at the counter) ----
        // sale.paid_amount_paise is what was tendered with the bill; the payment
        // table is money collected later against an outstanding balance. Both
        // are real cash in, so the dashboard shows them side by side.
        var todayPayments = connection.QuerySingle<PaymentTotals>(
            $"""
            SELECT COUNT(*) AS PaymentCount, COALESCE(SUM(amount_paise), 0) AS AmountPaise
              FROM payment WHERE payment_date = @date{paymentMethodFilter}
            """, new { date = today, method });

        var monthPayments = connection.QuerySingle<PaymentTotals>(
            $"""
            SELECT COUNT(*) AS PaymentCount, COALESCE(SUM(amount_paise), 0) AS AmountPaise
              FROM payment WHERE payment_date BETWEEN @from AND @to{paymentMethodFilter}
            """, new { from = monthStart, to = today, method });

        // The by-method breakdowns deliberately ignore the filter: when you have
        // narrowed to UPI, a one-row "UPI" table tells you nothing. These stay
        // full so the filtered headline figures always have context.
        var paymentsByMethod = connection.Query(
            """
            SELECT method AS Method, COUNT(*) AS PaymentCount, COALESCE(SUM(amount_paise), 0) AS AmountPaise
              FROM payment WHERE payment_date BETWEEN @from AND @to
             GROUP BY method ORDER BY AmountPaise DESC
            """, new { from = monthStart, to = today })
            .Select(r => new
            {
                method = (string)r.Method,
                count = (long)r.PaymentCount,
                amount = Money.ToRupees((long)r.AmountPaise),
            });

        var recentPayments = connection.Query(
            """
            SELECT p.id AS Id, p.payment_date AS PaymentDate, c.name AS CustomerName, c.code AS CustomerCode,
                   p.amount_paise AS AmountPaise, p.method AS Method
              FROM payment p JOIN customer c ON c.id = p.customer_id
             ORDER BY p.payment_date DESC, p.id DESC LIMIT 10
            """)
            .Select(r => new
            {
                id = (int)r.Id,
                paymentDate = (string)r.PaymentDate,
                customerName = (string)r.CustomerName,
                customerCode = (string)r.CustomerCode,
                amount = Money.ToRupees((long)r.AmountPaise),
                method = (string)r.Method,
            });

        // ---- registered vs local, today and this month ----
        var splitToday = SplitByType(connection, today, today, method);
        var splitMonth = SplitByType(connection, monthStart, today, method);

        // How counter takings were tendered this month.
        var salesByMethod = connection.Query(
            """
            SELECT payment_method AS Method, COUNT(*) AS SaleCount,
                   COALESCE(SUM(paid_amount_paise), 0) AS AmountPaise
              FROM sale
             WHERE is_void = 0 AND sale_date BETWEEN @from AND @to AND paid_amount_paise > 0
             GROUP BY payment_method ORDER BY AmountPaise DESC
            """, new { from = monthStart, to = today })
            .Select(r => new
            {
                method = (string)r.Method,
                count = (long)r.SaleCount,
                amount = Money.ToRupees((long)r.AmountPaise),
            });

        var customerCount = connection.ExecuteScalar<int>("SELECT COUNT(*) FROM customer WHERE is_active = 1");

        // Answered from the covering partial index - the same one the POS
        // bootstrap uses.
        var totalOutstanding = connection.ExecuteScalar<long>(
            "SELECT COALESCE(SUM(balance_amount_paise), 0) FROM sale WHERE is_void = 0 AND balance_amount_paise <> 0");

        var stock = connection.Query(
            """
            SELECT p.id AS ProductId, p.name AS Name,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l WHERE l.product_id = p.id), 0) AS OnHand
              FROM product p WHERE p.tracks_stock = 1 AND p.is_active = 1
             ORDER BY p.sort_order, p.name
            """).Select(r => new { productId = (int)r.ProductId, name = (string)r.Name, onHand = (long)r.OnHand });

        // The date filter is repeated INSIDE the sale_line subquery on purpose.
        // Without it the subquery aggregates all 112k lines before the outer
        // WHERE narrows to one month - measured at ~125 ms per query, and this
        // pattern appears three times on this screen. Pushing the window down
        // takes each to well under a millisecond.
        var dailySales = connection.Query(
            """
            SELECT s.sale_date AS Date,
                   COALESCE(SUM(q.quantity), 0) AS Quantity,
                   COALESCE(SUM(s.total_amount_paise), 0) AS TotalPaise
              FROM sale s
              LEFT JOIN (
                    SELECT l.sale_id, SUM(l.quantity) AS quantity
                      FROM sale_line l
                      JOIN sale s2 ON s2.id = l.sale_id
                     WHERE s2.sale_date BETWEEN @from AND @to
                     GROUP BY l.sale_id
                   ) q ON q.sale_id = s.id
             WHERE s.is_void = 0 AND s.sale_date BETWEEN @from AND @to
             GROUP BY s.sale_date ORDER BY s.sale_date
            """, new { from = monthStart, to = today })
            .Select(r => new
            {
                date = (string)r.Date,
                quantity = (long)r.Quantity,
                total = Money.ToRupees((long)r.TotalPaise),
            });

        var monthlySales = connection.Query(
            """
            SELECT substr(s.sale_date, 1, 7) AS Month,
                   COALESCE(SUM(q.quantity), 0) AS Quantity,
                   COALESCE(SUM(s.total_amount_paise), 0) AS TotalPaise
              FROM sale s
              LEFT JOIN (
                    SELECT l.sale_id, SUM(l.quantity) AS quantity
                      FROM sale_line l
                      JOIN sale s2 ON s2.id = l.sale_id
                     WHERE s2.sale_date >= @from
                     GROUP BY l.sale_id
                   ) q ON q.sale_id = s.id
             WHERE s.is_void = 0 AND s.sale_date >= @from
             GROUP BY Month ORDER BY Month
            """, new { from = AddMonths(monthStart, -11) })
            .Select(r => new
            {
                month = (string)r.Month,
                quantity = (long)r.Quantity,
                total = Money.ToRupees((long)r.TotalPaise),
            });

        var topCustomers = connection.Query(
            """
            SELECT s.customer_id AS CustomerId, c.name AS Name, c.code AS Code,
                   COALESCE(SUM(q.quantity), 0) AS Quantity,
                   COALESCE(SUM(s.total_amount_paise), 0) AS TotalPaise
              FROM sale s
              JOIN customer c ON c.id = s.customer_id
              LEFT JOIN (
                    SELECT l.sale_id, SUM(l.quantity) AS quantity
                      FROM sale_line l
                      JOIN sale s2 ON s2.id = l.sale_id
                     WHERE s2.sale_date BETWEEN @from AND @to
                     GROUP BY l.sale_id
                   ) q ON q.sale_id = s.id
             WHERE s.is_void = 0 AND s.sale_date BETWEEN @from AND @to
             GROUP BY s.customer_id ORDER BY Quantity DESC LIMIT 10
            """, new { from = monthStart, to = today })
            .Select(r => new
            {
                customerId = (int)r.CustomerId,
                name = (string)r.Name,
                code = (string)r.Code,
                quantity = (long)r.Quantity,
                total = Money.ToRupees((long)r.TotalPaise),
            });

        // Carried over from the legacy dashboard, where this was the most
        // recently added feature. It is the business's only churn signal.
        var dormantCustomers = connection.Query(
            """
            SELECT c.id AS CustomerId, c.name AS Name, c.code AS Code,
                   (SELECT MAX(s.sale_date) FROM sale s WHERE s.customer_id = c.id AND s.is_void = 0) AS LastSaleDate,
                   COALESCE((SELECT SUM(s.balance_amount_paise) FROM sale s
                              WHERE s.customer_id = c.id AND s.is_void = 0 AND s.balance_amount_paise <> 0), 0) AS BalancePaise
              FROM customer c
             WHERE c.is_active = 1
               AND NOT EXISTS (SELECT 1 FROM sale s
                                WHERE s.customer_id = c.id AND s.is_void = 0 AND s.sale_date >= @cutoff)
             ORDER BY LastSaleDate DESC NULLS LAST
             LIMIT 25
            """, new { cutoff = AddDays(today, -2) })
            .Select(r => new
            {
                customerId = (int)r.CustomerId,
                name = (string)r.Name,
                code = (string)r.Code,
                lastSaleDate = (string?)r.LastSaleDate,
                balance = Money.ToRupees((long)r.BalancePaise),
            });

        return Results.Ok(new
        {
            today = new
            {
                saleCount = todayTotals.SaleCount,
                quantity = todayTotals.Quantity,
                total = Money.ToRupees(todayTotals.TotalPaise),
                paid = Money.ToRupees(todayTotals.PaidPaise),
                balance = Money.ToRupees(todayTotals.BalancePaise),
            },
            currentMonth = new
            {
                quantity = currentMonth.Quantity,
                total = Money.ToRupees(currentMonth.TotalPaise),
                paid = Money.ToRupees(currentMonth.PaidPaise),
                balance = Money.ToRupees(currentMonth.BalancePaise),
                expenses = Money.ToRupees(currentMonthExpenses),
            },
            previousMonth = new
            {
                quantity = previousMonth.Quantity,
                total = Money.ToRupees(previousMonth.TotalPaise),
                paid = Money.ToRupees(previousMonth.PaidPaise),
                balance = Money.ToRupees(previousMonth.BalancePaise),
                expenses = Money.ToRupees(previousMonthExpenses),
            },
            customerCount,
            totalOutstanding = Money.ToRupees(totalOutstanding),
            yearStart,

            payments = new
            {
                today = new { count = todayPayments.PaymentCount, amount = Money.ToRupees(todayPayments.AmountPaise) },
                month = new { count = monthPayments.PaymentCount, amount = Money.ToRupees(monthPayments.AmountPaise) },
                byMethod = paymentsByMethod,
                recent = recentPayments,
            },

            // Total cash in = tendered at the counter + collected against
            // outstanding balances. Neither figure alone is the day's takings.
            collectedToday = Money.ToRupees(todayTotals.PaidPaise + todayPayments.AmountPaise),
            collectedMonth = Money.ToRupees(currentMonth.PaidPaise + monthPayments.AmountPaise),

            split = new { today = splitToday, month = splitMonth },
            salesByMethod,

            stock,
            dailySales,
            monthlySales,
            topCustomers,
            dormantCustomers,
        });
    }

    /// <summary>Registered vs local revenue for a date window.</summary>
    private static object SplitByType(
        Microsoft.Data.Sqlite.SqliteConnection connection, string from, string to, string? method)
    {
        var rows = connection.Query(
            $"""
            SELECT s.is_local AS IsLocal,
                   COUNT(*) AS SaleCount,
                   COALESCE(SUM(q.quantity), 0) AS Quantity,
                   COALESCE(SUM(s.total_amount_paise), 0) AS TotalPaise,
                   COALESCE(SUM(s.paid_amount_paise), 0) AS PaidPaise
              FROM sale s
              LEFT JOIN (
                    SELECT l.sale_id, SUM(l.quantity) AS quantity
                      FROM sale_line l JOIN sale s2 ON s2.id = l.sale_id
                     WHERE s2.sale_date BETWEEN @from AND @to
                     GROUP BY l.sale_id
                   ) q ON q.sale_id = s.id
             WHERE s.is_void = 0 AND s.sale_date BETWEEN @from AND @to
               {(method is null ? "" : "AND s.payment_method = @method")}
             GROUP BY s.is_local
            """, new { from, to, method }).ToList();

        object Pick(long isLocal)
        {
            var row = rows.FirstOrDefault(r => (long)r.IsLocal == isLocal);
            return row is null
                ? new { saleCount = 0L, quantity = 0L, total = 0m, paid = 0m }
                : new
                {
                    saleCount = (long)row.SaleCount,
                    quantity = (long)row.Quantity,
                    total = Money.ToRupees((long)row.TotalPaise),
                    paid = Money.ToRupees((long)row.PaidPaise),
                };
        }

        return new { registered = Pick(0), local = Pick(1) };
    }

    private static PeriodTotals PeriodSummary(
        Microsoft.Data.Sqlite.SqliteConnection connection, string from, string to, string? method) =>
        connection.QuerySingle<PeriodTotals>(
            $"""
            SELECT COUNT(*) AS SaleCount,
                   COALESCE((SELECT SUM(l.quantity) FROM sale_line l JOIN sale s2 ON s2.id = l.sale_id
                              WHERE s2.sale_date BETWEEN @from AND @to AND s2.is_void = 0
                                {(method is null ? "" : "AND s2.payment_method = @method")}), 0) AS Quantity,
                   COALESCE(SUM(total_amount_paise), 0)   AS TotalPaise,
                   COALESCE(SUM(paid_amount_paise), 0)    AS PaidPaise,
                   COALESCE(SUM(balance_amount_paise), 0) AS BalancePaise
              FROM sale WHERE sale_date BETWEEN @from AND @to AND is_void = 0
                {(method is null ? "" : "AND payment_method = @method")}
            """, new { from, to, method });

    // Dates are ISO text throughout, so arithmetic goes via DateOnly rather than
    // string surgery.
    private static string AddDays(string date, int days) =>
        DateOnly.ParseExact(date, Clock.DateFormat).AddDays(days).ToString(Clock.DateFormat);

    private static string AddMonths(string date, int months) =>
        DateOnly.ParseExact(date, Clock.DateFormat).AddMonths(months).ToString(Clock.DateFormat);

    private static string PreviousMonthStart(string monthStart) =>
        DateOnly.ParseExact(monthStart, Clock.DateFormat).AddMonths(-1).ToString(Clock.DateFormat);

    private sealed class PeriodTotals
    {
        public int SaleCount { get; init; }
        public long Quantity { get; init; }
        public long TotalPaise { get; init; }
        public long PaidPaise { get; init; }
        public long BalancePaise { get; init; }
    }

    private sealed class PaymentTotals
    {
        public int PaymentCount { get; init; }
        public long AmountPaise { get; init; }
    }
}

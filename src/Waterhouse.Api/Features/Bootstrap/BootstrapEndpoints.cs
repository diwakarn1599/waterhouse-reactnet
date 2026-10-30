using Dapper;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;

namespace Waterhouse.Api.Features.Bootstrap;

/// <summary>
/// The single payload that makes the POS screen instant.
/// </summary>
/// <remarks>
/// This is the architectural centre of the application. Fetched once when the
/// till is opened, it carries everything needed to complete a sale: the branch
/// details for the receipt, every product and rate, and EVERY customer with
/// their current outstanding balance.
///
/// After this call the POS performs no network request on the critical path.
/// Selecting a customer, seeing their balance, computing a total and printing a
/// receipt are all local and take microseconds. The legacy screen issued two
/// sequential AJAX calls before the operator could type a quantity, and one of
/// them summed an unindexed 112k-row table.
///
/// About 400 customers is roughly 30 KB gzipped, and the balance query is a
/// covering-index scan of only the ~11% of sales that carry a balance - about
/// 1.5 ms. Sending everything up front is far cheaper than fetching per customer.
///
/// Because branches share no customers, this payload is complete and
/// authoritative: the till holds correct balances even with the server
/// unreachable, so an outage degrades nothing at the counter.
/// </remarks>
public sealed class BootstrapEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/bootstrap", Get)
            .WithTags("Bootstrap")
            .RequireAuthorization(Policies.SignedIn);
    }

    private static IResult Get(IDbConnectionFactory connectionFactory, IClock clock)
    {
        using var connection = connectionFactory.Open();

        var branch = connection.QuerySingle(
            "SELECT code AS Code, name AS Name, address AS Address, phone AS Phone, gstin AS Gstin, receipt_footer AS ReceiptFooter FROM branch WHERE id = 1");

        // Cap colours: giveaway stock, never sold, chosen per line on the Sell
        // screen. Carried separately from `products` so the sell picker and the
        // cap picker cannot be confused with one another.
        var caps = connection.Query(
            """
            SELECT p.id AS Id, p.code AS Code, p.name AS Name,
                   COALESCE((SELECT SUM(change_qty) FROM stock_ledger l WHERE l.product_id = p.id), 0) AS OnHand
              FROM product p
             WHERE p.is_active = 1 AND p.tracks_stock = 1 AND p.is_sellable = 0
             ORDER BY p.sort_order, p.name
            """)
            .Select(c => new
            {
                id = (int)c.Id,
                code = (string)c.Code,
                name = (string)c.Name,
                onHand = (long)c.OnHand,
            }).ToList();

        var products = connection.Query(
            """
            SELECT id AS Id, code AS Code, name AS Name, unit AS Unit,
                   is_sellable AS IsSellable, tracks_stock AS TracksStock,
                   default_rate_paise AS DefaultRatePaise, sort_order AS SortOrder
              FROM product WHERE is_active = 1 ORDER BY sort_order, name
            """)
            .Select(p => new
            {
                id = (int)p.Id,
                code = (string)p.Code,
                name = (string)p.Name,
                unit = (string)p.Unit,
                isSellable = (long)p.IsSellable == 1,
                tracksStock = (long)p.TracksStock == 1,
                defaultRate = Money.ToRupees((long)p.DefaultRatePaise),
            }).ToList();

        // Balances come from the covering partial index: only sales that
        // actually carry a balance are touched. Named classes rather than
        // ValueTuples - Dapper binds tuples positionally, ignoring names.
        var balances = connection.Query<BalanceRow>(
            """
            SELECT customer_id AS CustomerId, SUM(balance_amount_paise) AS BalancePaise
              FROM sale
             WHERE is_void = 0 AND balance_amount_paise <> 0
             GROUP BY customer_id
            """).ToDictionary(r => r.CustomerId, r => r.BalancePaise);

        var rates = connection.Query<RateRow>(
            "SELECT customer_id AS CustomerId, product_id AS ProductId, rate_paise AS RatePaise FROM customer_product_rate")
            .GroupBy(r => r.CustomerId)
            .ToDictionary(g => g.Key, g => g.ToDictionary(r => r.ProductId, r => r.RatePaise));

        var customers = connection.Query(
            """
            SELECT id AS Id, code AS Code, name AS Name, company_name AS CompanyName,
                   phone AS Phone, is_active AS IsActive
              FROM customer WHERE is_active = 1 ORDER BY name COLLATE NOCASE
            """)
            .Select(c =>
            {
                var id = (int)c.Id;
                return new
                {
                    id,
                    code = (string)c.Code,
                    name = (string)c.Name,
                    companyName = (string)c.CompanyName,
                    phone = (string)c.Phone,
                    balance = Money.ToRupees(balances.GetValueOrDefault(id)),
                    rates = rates.TryGetValue(id, out var r)
                        ? r.ToDictionary(kv => kv.Key.ToString(), kv => Money.ToRupees(kv.Value))
                        : new Dictionary<string, decimal>(),
                };
            }).ToList();

        var stock = connection.Query<StockRow>(
            "SELECT product_id AS ProductId, SUM(change_qty) AS OnHand FROM stock_ledger GROUP BY product_id")
            .ToDictionary(r => r.ProductId.ToString(), r => r.OnHand);

        // Quick-rate buttons for local walk-in entry, per product.
        //
        // Derived from what the counter actually charges over the last two years
        // rather than hard-coded, so the buttons stay right as prices move and
        // no one has to maintain a list. On the migrated data this surfaces
        // 20, 15 and 10 for cans - the three most-used rates by a wide margin.
        // Configured walk-in rate buttons, in the order an administrator set.
        //
        // These were originally derived from sales history. That adapted with no
        // configuration but was unpredictable: one local sale at a single rate
        // was enough to collapse the whole button set to that rate. A counter
        // needs to show the same buttons every time, so they are now explicit.
        var quickRates = connection.Query<QuickRateRow>(
            """
            SELECT product_id AS ProductId, rate_paise AS RatePaise, sort_order AS SortOrder
              FROM local_rate
             WHERE is_active = 1
             ORDER BY product_id, sort_order, rate_paise
            """)
            .GroupBy(r => r.ProductId)
            .ToDictionary(
                g => g.Key.ToString(),
                g => g.Select(r => Money.ToRupees(r.RatePaise)).ToList());

        return Results.Ok(new
        {
            branch = new
            {
                code = (string)branch.Code,
                name = (string)branch.Name,
                address = (string)branch.Address,
                phone = (string)branch.Phone,
                gstin = (string)branch.Gstin,
                receiptFooter = (string)branch.ReceiptFooter,
            },
            today = clock.Today(),
            serverTime = clock.NowIso(),
            products,
            caps,
            customers,
            stock,
            quickRates,
        });
    }

    private sealed class BalanceRow
    {
        public int CustomerId { get; init; }
        public long BalancePaise { get; init; }
    }

    private sealed class RateRow
    {
        public int CustomerId { get; init; }
        public int ProductId { get; init; }
        public long RatePaise { get; init; }
    }

    private sealed class StockRow
    {
        public int ProductId { get; init; }
        public long OnHand { get; init; }
    }

    private sealed class QuickRateRow
    {
        public int ProductId { get; init; }
        public long RatePaise { get; init; }
        public int SortOrder { get; init; }
    }
}

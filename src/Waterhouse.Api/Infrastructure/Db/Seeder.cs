using Dapper;
using Waterhouse.Api.Infrastructure.Auth;

namespace Waterhouse.Api.Infrastructure.Db;

/// <summary>
/// Ensures the database is usable on first start.
/// </summary>
/// <remarks>
/// Reference data (branch, products, sequences, expense categories) is seeded by
/// migration 0003. Only the administrator account is created here, because a
/// password hash cannot be computed in SQL.
///
/// Idempotent: it creates an administrator only when the table holds no account
/// that can actually sign in. That distinction matters after a legacy import -
/// two user rows exist, but both have an empty hash and neither can log in, so
/// without this check the deployment would have no way in.
/// </remarks>
public sealed class Seeder(IDbConnectionFactory connectionFactory, IConfiguration configuration, ILogger<Seeder> logger)
{
    public void Run()
    {
        using var connection = connectionFactory.Open();

        var loginCapableAccounts = connection.ExecuteScalar<int>(
            "SELECT COUNT(*) FROM app_user WHERE is_active = 1 AND password_hash <> ''");

        if (loginCapableAccounts > 0)
        {
            SeedDemoData(connection);
            return;
        }

        var username = configuration["Seed:AdminUsername"] ?? "admin";
        var password = configuration["Seed:AdminPassword"];
        var generated = false;

        if (string.IsNullOrWhiteSpace(password))
        {
            // Never ship a fixed default password. A random one is printed once,
            // to the log, and is unusable by anyone who cannot read the server.
            password = GenerateReadablePassword();
            generated = true;
        }

        var now = Clock.NowIso();
        var existingId = connection.ExecuteScalar<long?>(
            "SELECT id FROM app_user WHERE username = @username", new { username });

        if (existingId is not null)
        {
            connection.Execute(
                """
                UPDATE app_user
                   SET password_hash = @hash, role = 'admin', is_active = 1, updated_at = @now
                 WHERE id = @id
                """,
                new { hash = PasswordHasher.Hash(password), now, id = existingId });
        }
        else
        {
            connection.Execute(
                """
                INSERT INTO app_user (username, display_name, email, password_hash, role, is_active, created_at, updated_at)
                VALUES (@username, 'Administrator', '', @hash, 'admin', 1, @now, @now)
                """,
                new { username, hash = PasswordHasher.Hash(password), now });
        }

        SeedDemoData(connection);

        if (generated)
        {
            logger.LogWarning(
                "No account could sign in, so an administrator was created.\n" +
                "    username: {Username}\n" +
                "    password: {Password}\n" +
                "This password is shown once and is not stored anywhere in readable form. " +
                "Sign in and change it now.", username, password);
        }
        else
        {
            logger.LogInformation(
                "Administrator '{Username}' created from the configured Seed:AdminPassword.", username);
        }
    }

    /// <summary>
    /// Sample customers and opening cap stock, for a throwaway demo instance.
    /// </summary>
    /// <remarks>
    /// Enabled with <c>Seed:Demo=true</c> and OFF by default, so it can never
    /// fire against a real branch database.
    ///
    /// It exists because a genuinely empty install cannot be tested: with no
    /// customers the POS has nothing to sell to, and with no cap stock every
    /// sale warns. A tester handed a blank app concludes it is broken.
    ///
    /// Guarded on the customer table being empty, so a restart on a host with a
    /// persistent disk will not keep re-adding the same rows.
    /// </remarks>
    private void SeedDemoData(Microsoft.Data.Sqlite.SqliteConnection connection)
    {
        if (!configuration.GetValue("Seed:Demo", false)) return;

        if (connection.ExecuteScalar<int>("SELECT COUNT(*) FROM customer") > 0) return;

        var now = Clock.NowIso();
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");

        string[,] samples =
        {
            { "Ravi Kumar", "Sri Lakshmi Stores", "9840012345", "800" },
            { "Anitha S", "Anitha Caterers", "9840023456", "900" },
            { "Murugan M", "", "9840034567", "1000" },
            { "Fathima Begum", "Crescent Mess", "9840045678", "850" },
            { "Karthik R", "KR Tea Stall", "9840056789", "1200" },
            { "Sundaram P", "Hotel Sangeetha", "9840067890", "750" },
            { "Lakshmi N", "", "9840078901", "1000" },
            { "Joseph A", "St. Mary Canteen", "9840089012", "950" },
        };

        var canId = connection.ExecuteScalar<int>("SELECT id FROM product WHERE code = 'CAN'");

        using var transaction = connection.BeginTransaction(deferred: false);

        for (var i = 0; i < samples.GetLength(0); i++)
        {
            var code = $"CUST-{(i + 1):D4}";
            var customerId = connection.ExecuteScalar<long>(
                """
                INSERT INTO customer (code, name, company_name, phone, address, note, is_active, created_at, updated_at)
                VALUES (@code, @name, @company, @phone, '', 'demo data', 1, @now, @now);
                SELECT last_insert_rowid();
                """,
                new { code, name = samples[i, 0], company = samples[i, 1], phone = samples[i, 2], now },
                transaction);

            connection.Execute(
                """
                INSERT INTO customer_product_rate (customer_id, product_id, rate_paise, updated_at)
                VALUES (@customerId, @productId, @rate, @now)
                """,
                new { customerId, productId = canId, rate = int.Parse(samples[i, 3]), now }, transaction);
        }

        // Opening cap stock so the counter can actually sell without warnings.
        foreach (var code in new[] { "CAP-BLUE", "CAP-GREEN", "CAP-WHITE" })
        {
            var productId = connection.ExecuteScalar<int?>(
                "SELECT id FROM product WHERE code = @code", new { code }, transaction);
            if (productId is null) continue;

            var receiptId = connection.ExecuteScalar<long>(
                """
                INSERT INTO stock_receipt (product_id, receipt_date, quantity, amount_paise, note, created_at, updated_at)
                VALUES (@productId, @today, 500, 0, 'demo opening stock', @now, @now);
                SELECT last_insert_rowid();
                """, new { productId, today, now }, transaction);

            connection.Execute(
                """
                INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_at)
                VALUES (@productId, @today, 500, 'RECEIPT', @refId, 'demo opening stock', @now)
                """, new { productId, today, refId = receiptId, now }, transaction);
        }

        // Advance the customer sequence past the seeded codes so the first
        // customer added through the UI does not collide.
        connection.Execute(
            "UPDATE number_sequence SET next_value = @next, updated_at = @now WHERE name = 'customer'",
            new { next = samples.GetLength(0) + 1, now }, transaction);

        transaction.Commit();

        logger.LogWarning(
            "Seed:Demo is enabled - {Count} sample customers and 500 of each cap colour were created. " +
            "Never enable this against a real branch database.", samples.GetLength(0));
    }

    /// <summary>
    /// A readable random password. Excludes characters that are misread aloud or
    /// off a screen (0/O, 1/l/I), because this one gets typed by hand from a log.
    /// </summary>
    private static string GenerateReadablePassword()
    {
        const string alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
        return string.Create(16, alphabet, (span, chars) =>
        {
            for (var i = 0; i < span.Length; i++)
            {
                span[i] = chars[System.Security.Cryptography.RandomNumberGenerator.GetInt32(chars.Length)];
            }
        });
    }
}

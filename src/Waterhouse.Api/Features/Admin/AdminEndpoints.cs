using System.Security.Claims;
using Dapper;
using Microsoft.Data.Sqlite;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Admin;

public sealed record CreateUserRequest(string Username, string DisplayName, string? Email, string Role, string Password);
public sealed record SetPasswordRequest(string NewPassword);
public sealed record UpdateBranchRequest(string Name, string? Address, string? Phone, string? Gstin, string? ReceiptFooter);
public sealed record SetLocalRatesRequest(List<decimal>? Rates);

public sealed class AdminEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/admin").WithTags("Admin").RequireAuthorization(Policies.AdminOnly);

        group.MapGet("/users", ListUsers);
        group.MapPost("/users", CreateUser);
        group.MapPost("/users/{id:int}/password", SetPassword);
        group.MapPost("/users/{id:int}/active", SetActive);
        group.MapPut("/branch", UpdateBranch);
        group.MapGet("/local-rates", GetLocalRates);
        group.MapPut("/local-rates/{productId:int}", SetLocalRates);
        group.MapGet("/backup/status", BackupStatus);
        group.MapGet("/backup/download", DownloadBackup);
        group.MapGet("/audit", AuditLog);
    }

    private static IResult ListUsers(IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();
        var rows = connection.Query(
            """
            SELECT id AS Id, username AS Username, display_name AS DisplayName, email AS Email,
                   role AS Role, is_active AS IsActive, last_login_at AS LastLoginAt,
                   CASE WHEN password_hash = '' THEN 0 ELSE 1 END AS CanSignIn
              FROM app_user ORDER BY username
            """);

        return Results.Ok(rows.Select(r => new
        {
            id = (int)r.Id,
            username = (string)r.Username,
            displayName = (string)r.DisplayName,
            email = (string)r.Email,
            role = (string)r.Role,
            isActive = (long)r.IsActive == 1,
            // False for accounts imported from the legacy database: their hashes
            // are PHP bcrypt, which this application does not implement.
            canSignIn = (long)r.CanSignIn == 1,
            lastLoginAt = (string?)r.LastLoginAt,
        }));
    }

    private static IResult CreateUser(CreateUserRequest request, IDbConnectionFactory connectionFactory)
    {
        var validator = new Validator()
            .RequireText(request.Username, "username", 100)
            .RequireText(request.DisplayName, "displayName", 255)
            .Require(request.Password?.Length >= 8, "password", "Must be at least 8 characters.")
            .Require(request.Role is Roles.Admin or Roles.Operator, "role", "Must be admin or operator.");
        if (validator.Problem() is { } problem) return problem;

        using var connection = connectionFactory.Open();

        var taken = connection.ExecuteScalar<int>(
            "SELECT COUNT(*) FROM app_user WHERE username = @username COLLATE NOCASE",
            new { username = request.Username.Trim() });
        if (taken > 0) return ApiResults.Conflict("That username is already in use.");

        var now = Clock.NowIso();
        var id = connection.ExecuteScalar<long>(
            """
            INSERT INTO app_user (username, display_name, email, password_hash, role, is_active, created_at, updated_at)
            VALUES (@username, @displayName, @email, @hash, @role, 1, @now, @now);
            SELECT last_insert_rowid();
            """,
            new
            {
                username = request.Username.Trim().ToLowerInvariant(),
                displayName = request.DisplayName.Trim(),
                email = request.Email?.Trim() ?? string.Empty,
                hash = PasswordHasher.Hash(request.Password!),
                role = request.Role,
                now,
            });

        return Results.Created($"/api/admin/users/{id}", new { id = (int)id });
    }

    private static IResult SetPassword(int id, SetPasswordRequest request, IDbConnectionFactory connectionFactory)
    {
        var validator = new Validator()
            .Require(request.NewPassword?.Length >= 8, "newPassword", "Must be at least 8 characters.");
        if (validator.Problem() is { } problem) return problem;

        using var connection = connectionFactory.Open();
        var affected = connection.Execute(
            "UPDATE app_user SET password_hash = @hash, updated_at = @now WHERE id = @id",
            new { hash = PasswordHasher.Hash(request.NewPassword!), now = Clock.NowIso(), id });

        return affected == 0 ? ApiResults.NotFound("User", id) : Results.NoContent();
    }

    private static IResult SetActive(int id, bool active, ClaimsPrincipal principal, IDbConnectionFactory connectionFactory)
    {
        var current = principal.RequireUser();

        // Locking yourself out of the only administrator account would need
        // database access to undo.
        if (id == current.Id && !active)
        {
            return ApiResults.Unprocessable("You cannot deactivate your own account.");
        }

        using var connection = connectionFactory.Open();

        if (!active)
        {
            var remainingAdmins = connection.ExecuteScalar<int>(
                """
                SELECT COUNT(*) FROM app_user
                 WHERE role = 'admin' AND is_active = 1 AND password_hash <> '' AND id <> @id
                """, new { id });
            if (remainingAdmins == 0)
            {
                return ApiResults.Unprocessable("This is the last administrator who can sign in.");
            }
        }

        var affected = connection.Execute(
            "UPDATE app_user SET is_active = @active, updated_at = @now WHERE id = @id",
            new { active = active ? 1 : 0, now = Clock.NowIso(), id });

        return affected == 0 ? ApiResults.NotFound("User", id) : Results.NoContent();
    }

    private static IResult UpdateBranch(UpdateBranchRequest request, IDbConnectionFactory connectionFactory)
    {
        var validator = new Validator().RequireText(request.Name, "name", 255);
        if (validator.Problem() is { } problem) return problem;

        using var connection = connectionFactory.Open();
        connection.Execute(
            """
            UPDATE branch
               SET name = @name, address = @address, phone = @phone, gstin = @gstin,
                   receipt_footer = @receiptFooter, updated_at = @now
             WHERE id = 1
            """,
            new
            {
                name = request.Name.Trim(),
                address = request.Address?.Trim() ?? string.Empty,
                phone = request.Phone?.Trim() ?? string.Empty,
                gstin = request.Gstin?.Trim() ?? string.Empty,
                receiptFooter = request.ReceiptFooter?.Trim() ?? string.Empty,
                now = Clock.NowIso(),
            });

        return Results.NoContent();
    }

    /// <summary>Configured walk-in rate buttons, grouped by sellable product.</summary>
    private static IResult GetLocalRates(IDbConnectionFactory connectionFactory)
    {
        using var connection = connectionFactory.Open();

        var rates = connection.Query(
            """
            SELECT r.product_id AS ProductId, r.rate_paise AS RatePaise, r.sort_order AS SortOrder
              FROM local_rate r
             WHERE r.is_active = 1
             ORDER BY r.product_id, r.sort_order, r.rate_paise
            """)
            .GroupBy(r => (int)r.ProductId)
            .ToDictionary(g => g.Key, g => g.Select(r => Money.ToRupees((long)r.RatePaise)).ToList());

        var products = connection.Query(
            "SELECT id AS Id, code AS Code, name AS Name FROM product WHERE is_sellable = 1 AND is_active = 1 ORDER BY sort_order, name");

        return Results.Ok(products.Select(p => new
        {
            productId = (int)p.Id,
            code = (string)p.Code,
            name = (string)p.Name,
            rates = rates.GetValueOrDefault((int)p.Id, []),
        }));
    }

    /// <summary>
    /// Replace the rate list for one product.
    /// </summary>
    /// <remarks>
    /// Replaces wholesale rather than patching: the list is short, order matters
    /// (it is button order at the counter), and removing a rate has to be
    /// expressible. Rows are deleted and re-inserted inside one transaction.
    /// </remarks>
    private static IResult SetLocalRates(int productId, SetLocalRatesRequest request, IDbConnectionFactory connectionFactory)
    {
        var rates = (request.Rates ?? [])
            .Where(r => r > 0)
            .Distinct()
            .ToList();

        var validator = new Validator()
            .Require(rates.Count > 0, "rates", "At least one rate is required.")
            .Require(rates.Count <= 8, "rates", "At most eight rate buttons fit on the counter screen.");

        foreach (var rate in rates)
        {
            if (rate > 100_000) validator.Add("rates", $"{rate} is unreasonably large for a unit rate.");
        }
        if (validator.Problem() is { } problem) return problem;

        using var connection = connectionFactory.Open();

        return connection.InTransaction(transaction =>
        {
            var sellable = connection.ExecuteScalar<int>(
                "SELECT COUNT(*) FROM product WHERE id = @id AND is_sellable = 1", new { id = productId }, transaction);
            if (sellable == 0) return ApiResults.NotFound("Sellable product", productId);

            connection.Execute("DELETE FROM local_rate WHERE product_id = @productId",
                new { productId }, transaction);

            var now = Clock.NowIso();
            var order = 1;
            foreach (var rate in rates.OrderBy(r => r))
            {
                connection.Execute(
                    """
                    INSERT INTO local_rate (product_id, rate_paise, sort_order, is_active, created_at, updated_at)
                    VALUES (@productId, @rate, @order, 1, @now, @now)
                    """,
                    new { productId, rate = Money.FromRupees(rate), order = order++, now }, transaction);
            }

            return Results.Ok(new { productId, rates = rates.OrderBy(r => r).ToList() });
        });
    }

    private static IResult BackupStatus(IDbConnectionFactory connectionFactory)
    {
        var databasePath = connectionFactory.DatabasePath;

        var size = File.Exists(databasePath) ? new FileInfo(databasePath).Length : 0;
        var walPath = databasePath + "-wal";
        var walSize = File.Exists(walPath) ? new FileInfo(walPath).Length : 0;

        return Results.Ok(new
        {
            databaseSizeBytes = size,
            walSizeBytes = walSize,
            lastBackupAt = (string?)null,
        });
    }

    /// <summary>
    /// Stream a consistent snapshot of the database.
    /// </summary>
    /// <remarks>
    /// Uses SQLite's online backup API via <see cref="SqliteConnection.BackupDatabase"/>,
    /// so it is safe to run while the till is selling - unlike copying the file,
    /// which can capture a torn page mid-write.
    ///
    /// This is a convenience, not a backup strategy. Continuous replication
    /// belongs on the server; see docs/DEPLOYMENT.md.
    /// </remarks>
    private static async Task<IResult> DownloadBackup(IDbConnectionFactory connectionFactory, IClock clock, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger("Backup");
        var tempPath = Path.Combine(Path.GetTempPath(), $"waterhouse-backup-{Guid.NewGuid():N}.db");

        try
        {
            using (var source = connectionFactory.Open())
            using (var destination = new SqliteConnection(new SqliteConnectionStringBuilder
                   {
                       DataSource = tempPath,
                       Mode = SqliteOpenMode.ReadWriteCreate,
                       // Pooling MUST be off here. Microsoft.Data.Sqlite returns a
                       // pooled connection to the pool on Dispose rather than
                       // closing it, so the OS file handle stays open and the
                       // subsequent read fails with "the process cannot access the
                       // file". A backup target is written once and thrown away,
                       // so pooling has nothing to offer it anyway.
                       Pooling = false,
                   }.ToString()))
            {
                destination.Open();
                source.BackupDatabase(destination);
            }

            var bytes = await File.ReadAllBytesAsync(tempPath);
            var fileName = $"waterhouse-{clock.Today()}.db";
            logger.LogInformation("Backup downloaded ({Bytes} bytes)", bytes.Length);

            return Results.File(bytes, "application/octet-stream", fileName);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Backup failed");
            return Results.Problem(
                title: "Backup failed",
                detail: "The snapshot could not be created. Check the server log.",
                statusCode: StatusCodes.Status500InternalServerError);
        }
        finally
        {
            // Best effort: a leftover temp file is harmless, a crash here is not.
            try { if (File.Exists(tempPath)) File.Delete(tempPath); }
            catch (IOException) { /* the OS will reclaim it */ }
        }
    }

    private static IResult AuditLog(IDbConnectionFactory connectionFactory, string? entity, int pageSize = 200)
    {
        pageSize = Math.Clamp(pageSize, 1, 1000);

        using var connection = connectionFactory.Open();
        var rows = connection.Query(
            """
            SELECT a.id AS Id, a.entity AS Entity, a.entity_id AS EntityId, a.action AS Action,
                   a.detail AS Detail, a.created_at AS CreatedAt, u.display_name AS UserName
              FROM audit_log a
              LEFT JOIN app_user u ON u.id = a.user_id
             WHERE (@entity IS NULL OR a.entity = @entity)
             ORDER BY a.id DESC
             LIMIT @limit
            """, new { entity, limit = pageSize });

        return Results.Ok(new
        {
            items = rows.Select(r => new
            {
                id = (int)r.Id,
                entity = (string)r.Entity,
                entityId = (long)r.EntityId,
                action = (string)r.Action,
                detail = (string)r.Detail,
                createdAt = (string)r.CreatedAt,
                userName = (string?)r.UserName,
            }),
        });
    }
}

using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Dapper;

namespace Waterhouse.Api.Infrastructure.Db;

/// <summary>
/// Applies the embedded <c>Migrations/*.sql</c> scripts in filename order and
/// records each one in a journal table so it runs exactly once.
/// </summary>
/// <remarks>
/// Small on purpose. A migration is a plain .sql file named
/// <c>NNNN_description.sql</c>; there is no DSL and nothing to learn. Scripts
/// run inside a transaction, so a failure leaves the database untouched.
///
/// A checksum of each applied script is stored. If a script that has already run
/// is later edited, startup fails loudly rather than silently serving a schema
/// that does not match the one the code was written against.
/// </remarks>
public sealed class Migrator(IDbConnectionFactory connectionFactory, ILogger<Migrator> logger)
{
    private const string JournalTable = "schema_journal";

    public int Run()
    {
        using var connection = connectionFactory.Open();

        connection.Execute($"""
            CREATE TABLE IF NOT EXISTS {JournalTable} (
                script_name TEXT PRIMARY KEY,
                checksum    TEXT NOT NULL,
                applied_at  TEXT NOT NULL
            );
            """);

        // Named class rather than a ValueTuple: Dapper binds tuples positionally
        // and ignores element names.
        var applied = connection
            .Query<JournalRow>(
                $"SELECT script_name AS ScriptName, checksum AS Checksum FROM {JournalTable}")
            .ToDictionary(r => r.ScriptName, r => r.Checksum, StringComparer.Ordinal);

        var assembly = Assembly.GetExecutingAssembly();
        var scripts = assembly.GetManifestResourceNames()
            .Where(n => n.Contains(".Migrations.", StringComparison.Ordinal) && n.EndsWith(".sql", StringComparison.Ordinal))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        if (scripts.Count == 0)
        {
            throw new InvalidOperationException(
                "No migration scripts found as embedded resources. Check that Migrations\\*.sql " +
                "is included as <EmbeddedResource> in Waterhouse.Api.csproj.");
        }

        var executed = 0;
        foreach (var resourceName in scripts)
        {
            var scriptName = ShortName(resourceName);
            var sql = ReadResource(assembly, resourceName);
            var checksum = Checksum(sql);

            if (applied.TryGetValue(scriptName, out var previousChecksum))
            {
                if (!string.Equals(previousChecksum, checksum, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Migration '{scriptName}' has already been applied but its contents have " +
                        $"changed (checksum {previousChecksum} -> {checksum}). Applied migrations are " +
                        "immutable: add a new script instead of editing this one.");
                }
                continue;
            }

            logger.LogInformation("Applying migration {Script}", scriptName);
            using (var transaction = connection.BeginTransaction(deferred: false))
            {
                connection.Execute(sql, transaction: transaction);
                connection.Execute(
                    $"INSERT INTO {JournalTable} (script_name, checksum, applied_at) VALUES (@name, @checksum, @at)",
                    new { name = scriptName, checksum, at = Clock.NowIso() },
                    transaction);
                transaction.Commit();
            }
            executed++;
        }

        // Keeps the query planner honest as the tables grow. Cheap, and the only
        // database maintenance this application needs.
        connection.Execute("PRAGMA optimize;");

        logger.LogInformation(
            "Schema up to date: {Executed} migration(s) applied, {Total} known.", executed, scripts.Count);
        return executed;
    }

    private static string ShortName(string resourceName)
    {
        var marker = ".Migrations.";
        var index = resourceName.IndexOf(marker, StringComparison.Ordinal);
        return index < 0 ? resourceName : resourceName[(index + marker.Length)..];
    }

    private static string ReadResource(Assembly assembly, string resourceName)
    {
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{resourceName}' could not be opened.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private sealed class JournalRow
    {
        public string ScriptName { get; init; } = string.Empty;
        public string Checksum { get; init; } = string.Empty;
    }

    private static string Checksum(string text)
    {
        // Normalise line endings so a git checkout with different autocrlf
        // settings does not read as a modified migration.
        var normalised = text.Replace("\r\n", "\n", StringComparison.Ordinal);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalised)));
    }
}

using System.Data;
using Microsoft.Data.Sqlite;

namespace Waterhouse.Api.Infrastructure.Db;

public sealed class DatabaseOptions
{
    /// <summary>Path to the SQLite file. Relative paths resolve against ContentRoot.</summary>
    public string Path { get; set; } = "data/waterhouse.db";

    /// <summary>Seconds a writer waits for the write lock before failing.</summary>
    public int BusyTimeoutSeconds { get; set; } = 10;
}

/// <summary>
/// Hands out SQLite connections with the pragmas this application depends on.
/// </summary>
/// <remarks>
/// The pragmas are not optional tuning - correctness depends on them:
///
///   journal_mode=WAL   Readers never block the writer and the writer never
///                      blocks readers. With a single counter this is the
///                      difference between a report and a sale contending, and
///                      a sale never waiting at all.
///   foreign_keys=ON    SQLite ignores foreign keys unless asked, per
///                      connection. The legacy MySQL schema had no foreign keys
///                      at all; enforcing them is a large part of why the new
///                      schema can be trusted.
///   busy_timeout       Rather than failing instantly on a locked database, wait.
///   synchronous=NORMAL Safe under WAL: survives process crash. Full fsync per
///                      commit is not needed and costs latency on every sale.
/// </remarks>
public interface IDbConnectionFactory
{
    /// <summary>Opens a configured connection. Caller disposes.</summary>
    SqliteConnection Open();

    /// <summary>
    /// Resolved absolute path of the database file. Needed by the backup
    /// endpoint, which reports file sizes. On the interface rather than reached
    /// through a downcast, so swapping the implementation cannot break it.
    /// </summary>
    string DatabasePath { get; }
}

public sealed class SqliteConnectionFactory : IDbConnectionFactory
{
    private readonly string _connectionString;
    private readonly int _busyTimeoutMs;

    public SqliteConnectionFactory(DatabaseOptions options, string contentRoot)
    {
        var path = System.IO.Path.IsPathRooted(options.Path)
            ? options.Path
            : System.IO.Path.Combine(contentRoot, options.Path);

        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            // Shared cache is deliberately OFF. It serialises readers against
            // the writer, which is exactly what WAL is there to avoid.
            Cache = SqliteCacheMode.Private,
            Pooling = true,
        }.ToString();

        _busyTimeoutMs = Math.Max(1, options.BusyTimeoutSeconds) * 1000;
        DatabasePath = path;
    }

    /// <inheritdoc />
    public string DatabasePath { get; }

    public SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = $"""
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = {_busyTimeoutMs};
            PRAGMA synchronous = NORMAL;
            """;
        pragma.ExecuteNonQuery();
        return connection;
    }
}

public static class DbExtensions
{
    /// <summary>
    /// Runs <paramref name="work"/> inside an IMMEDIATE transaction.
    /// </summary>
    /// <remarks>
    /// IMMEDIATE takes the write lock up front rather than upgrading partway
    /// through. Without it two concurrent writers can both begin, both read, and
    /// then one fails at commit with SQLITE_BUSY after its work is done. Taking
    /// the lock first turns that into a short wait instead of a lost sale.
    /// </remarks>
    public static T InTransaction<T>(this SqliteConnection connection, Func<SqliteTransaction, T> work)
    {
        using var transaction = connection.BeginTransaction(deferred: false);
        var result = work(transaction);
        transaction.Commit();
        return result;
    }
}

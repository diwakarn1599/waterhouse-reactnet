using System.Security.Cryptography;
using System.Text;

namespace Waterhouse.Api.Infrastructure.Auth;

/// <summary>
/// PBKDF2-HMAC-SHA256 password hashing, using only what the framework provides.
/// </summary>
/// <remarks>
/// Stored format: <c>pbkdf2$sha256${iterations}${salt-b64}${hash-b64}</c>.
/// The iteration count travels with the hash, so it can be raised later without
/// invalidating existing passwords - <see cref="NeedsRehash"/> reports when a
/// stored hash is below the current cost, and the login path upgrades it
/// transparently on the next successful sign-in.
///
/// An EMPTY stored hash means "this account cannot sign in". Users imported from
/// the legacy database land in that state: their hashes are PHP bcrypt, which
/// this application deliberately does not implement rather than take a
/// dependency for two accounts. An administrator sets a password to enable them.
/// </remarks>
public static class PasswordHasher
{
    private const int SaltBytes = 16;
    private const int HashBytes = 32;
    private const int DefaultIterations = 210_000; // OWASP guidance for PBKDF2-SHA256
    private const string Prefix = "pbkdf2$sha256$";

    public static string Hash(string password, int iterations = DefaultIterations)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);

        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, HashBytes);

        return $"{Prefix}{iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    /// <summary>
    /// Verify a password. Returns false for an empty or malformed stored hash
    /// rather than throwing, so a disabled account behaves like a wrong password.
    /// </summary>
    public static bool Verify(string password, string? storedHash)
    {
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(storedHash)) return false;
        if (!storedHash.StartsWith(Prefix, StringComparison.Ordinal)) return false;

        var parts = storedHash.Split('$');
        // pbkdf2 | sha256 | iterations | salt | hash
        if (parts.Length != 5) return false;
        if (!int.TryParse(parts[2], out var iterations) || iterations < 1000) return false;

        byte[] salt, expected;
        try
        {
            salt = Convert.FromBase64String(parts[3]);
            expected = Convert.FromBase64String(parts[4]);
        }
        catch (FormatException)
        {
            return false;
        }
        if (salt.Length == 0 || expected.Length == 0) return false;

        var actual = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, expected.Length);

        // Fixed-time comparison: a length-or-content early exit would leak how
        // much of the hash matched.
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>True when a valid stored hash was made with a lower cost than current.</summary>
    public static bool NeedsRehash(string? storedHash)
    {
        if (string.IsNullOrEmpty(storedHash)) return false;
        var parts = storedHash.Split('$');
        if (parts.Length != 5 || !int.TryParse(parts[2], out var iterations)) return false;
        return iterations < DefaultIterations;
    }

    /// <summary>True when the account has no usable password and cannot sign in.</summary>
    public static bool IsLoginDisabled(string? storedHash) => string.IsNullOrEmpty(storedHash);
}

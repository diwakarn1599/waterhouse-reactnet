using System.Security.Claims;

namespace Waterhouse.Api.Infrastructure.Auth;

public static class Roles
{
    public const string Admin = "admin";
    public const string Operator = "operator";
}

public static class Policies
{
    /// <summary>Any signed-in, active user. Covers the POS and everyday screens.</summary>
    public const string SignedIn = "signed-in";

    /// <summary>Administrators only: users, settings, voids, backup, rate changes.</summary>
    public const string AdminOnly = "admin-only";
}

/// <summary>The signed-in user, resolved from the auth cookie.</summary>
public sealed record CurrentUser(int Id, string Username, string DisplayName, string Role)
{
    public bool IsAdmin => string.Equals(Role, Roles.Admin, StringComparison.Ordinal);
}

public static class ClaimsPrincipalExtensions
{
    public const string UserIdClaim = "wh:uid";

    /// <summary>
    /// Resolve the current user, or null when unauthenticated.
    /// </summary>
    /// <remarks>
    /// Endpoints behind an authorization policy can rely on this being non-null
    /// and use <see cref="RequireUser"/>. It returns null rather than throwing so
    /// that anonymous endpoints can ask without branching on exceptions.
    /// </remarks>
    public static CurrentUser? GetCurrentUser(this ClaimsPrincipal? principal)
    {
        if (principal?.Identity?.IsAuthenticated != true) return null;

        var idValue = principal.FindFirstValue(UserIdClaim);
        if (!int.TryParse(idValue, out var id)) return null;

        return new CurrentUser(
            id,
            principal.FindFirstValue(ClaimTypes.Name) ?? string.Empty,
            principal.FindFirstValue(ClaimTypes.GivenName) ?? string.Empty,
            principal.FindFirstValue(ClaimTypes.Role) ?? Roles.Operator);
    }

    /// <summary>
    /// Resolve the current user, throwing if absent. Only for endpoints that
    /// already require authorization - reaching the throw means a route was
    /// registered without its policy, which is a bug, not a runtime condition.
    /// </summary>
    public static CurrentUser RequireUser(this ClaimsPrincipal? principal) =>
        principal.GetCurrentUser()
        ?? throw new InvalidOperationException(
            "No authenticated user on a route that requires one. The endpoint is missing its authorization policy.");
}

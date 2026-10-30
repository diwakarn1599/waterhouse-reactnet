using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;
using Waterhouse.Api.Infrastructure.Http;

namespace Waterhouse.Api.Features.Auth;

public sealed record LoginRequest(string Username, string Password);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record UserInfo(int Id, string Username, string DisplayName, string Role);

public sealed class AuthEndpoints : IEndpointModule
{
    public void MapEndpoints(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth").WithTags("Auth");

        group.MapPost("/login", LoginAsync).AllowAnonymous().RequireRateLimiting("login");

        // Cast required (ASP0016). LogoutAsync's only parameter is HttpContext
        // and it returns Task<IResult>, which also matches RequestDelegate
        // (Func<HttpContext, Task>) - and that overload silently discards the
        // return value, so the 204 would never be written. The cast forces the
        // route-handler overload. Other handlers take extra parameters, so they
        // cannot match RequestDelegate and need no cast.
        group.MapPost("/logout", (Delegate)LogoutAsync).RequireAuthorization(Policies.SignedIn);
        group.MapGet("/me", Me).RequireAuthorization(Policies.SignedIn);
        group.MapPost("/change-password", ChangePassword).RequireAuthorization(Policies.SignedIn);
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest request,
        HttpContext http,
        IDbConnectionFactory connectionFactory)
    {
        var validator = new Validator()
            .RequireText(request.Username, "username", 100)
            .RequireText(request.Password, "password", 200);
        if (validator.Problem() is { } problem) return problem;

        using var connection = connectionFactory.Open();
        var user = connection.QuerySingleOrDefault<UserRow>(
            """
            SELECT id AS Id, username AS Username, display_name AS DisplayName,
                   password_hash AS PasswordHash, role AS Role, is_active AS IsActive
              FROM app_user
             WHERE username = @username COLLATE NOCASE
            """,
            new { username = request.Username.Trim() });

        // One message for every failure mode - unknown user, wrong password,
        // deactivated, or imported-without-a-password. Distinguishing them would
        // tell an attacker which usernames exist.
        const string failed = "The username or password is incorrect.";

        if (user is null || user.IsActive == 0 || !PasswordHasher.Verify(request.Password, user.PasswordHash))
        {
            return Results.Problem(title: "Sign-in failed", detail: failed, statusCode: StatusCodes.Status401Unauthorized);
        }

        // Transparently upgrade a hash made at a lower iteration count.
        if (PasswordHasher.NeedsRehash(user.PasswordHash))
        {
            connection.Execute(
                "UPDATE app_user SET password_hash = @hash, updated_at = @now WHERE id = @id",
                new { hash = PasswordHasher.Hash(request.Password), now = Clock.NowIso(), id = user.Id });
        }

        connection.Execute(
            "UPDATE app_user SET last_login_at = @now WHERE id = @id",
            new { now = Clock.NowIso(), id = user.Id });

        var identity = new ClaimsIdentity(
        [
            new Claim(ClaimsPrincipalExtensions.UserIdClaim, user.Id.ToString()),
            new Claim(ClaimTypes.Name, user.Username),
            new Claim(ClaimTypes.GivenName, user.DisplayName),
            new Claim(ClaimTypes.Role, user.Role),
        ], CookieAuthenticationDefaults.AuthenticationScheme);

        await http.SignInAsync(
            CookieAuthenticationDefaults.AuthenticationScheme,
            new ClaimsPrincipal(identity),
            new AuthenticationProperties { IsPersistent = true });

        return Results.Ok(new UserInfo(user.Id, user.Username, user.DisplayName, user.Role));
    }

    private static async Task<IResult> LogoutAsync(HttpContext http)
    {
        await http.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        return Results.NoContent();
    }

    private static IResult Me(ClaimsPrincipal principal)
    {
        var user = principal.RequireUser();
        return Results.Ok(new UserInfo(user.Id, user.Username, user.DisplayName, user.Role));
    }

    private static IResult ChangePassword(
        ChangePasswordRequest request,
        ClaimsPrincipal principal,
        IDbConnectionFactory connectionFactory)
    {
        var current = principal.RequireUser();

        var validator = new Validator()
            .RequireText(request.NewPassword, "newPassword", 200)
            .Require(request.NewPassword?.Length >= 8, "newPassword", "Must be at least 8 characters.");
        if (validator.Problem() is { } problem) return problem;

        using var connection = connectionFactory.Open();
        var storedHash = connection.ExecuteScalar<string>(
            "SELECT password_hash FROM app_user WHERE id = @id", new { id = current.Id });

        if (!PasswordHasher.Verify(request.CurrentPassword, storedHash))
        {
            return Results.Problem(
                title: "Sign-in failed", detail: "The current password is incorrect.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        connection.Execute(
            "UPDATE app_user SET password_hash = @hash, updated_at = @now WHERE id = @id",
            new { hash = PasswordHasher.Hash(request.NewPassword!), now = Clock.NowIso(), id = current.Id });

        return Results.NoContent();
    }

    private sealed class UserRow
    {
        public int Id { get; init; }
        public string Username { get; init; } = string.Empty;
        public string DisplayName { get; init; } = string.Empty;
        public string? PasswordHash { get; init; }
        public string Role { get; init; } = Roles.Operator;
        public int IsActive { get; init; }
    }
}

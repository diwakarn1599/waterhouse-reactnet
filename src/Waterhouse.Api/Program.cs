using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.Sqlite;
using Waterhouse.Api.Infrastructure;
using Waterhouse.Api.Infrastructure.Auth;
using Waterhouse.Api.Infrastructure.Db;
using Waterhouse.Api.Infrastructure.Endpoints;

var builder = WebApplication.CreateBuilder(args);

// -----------------------------------------------------------------------------
// Container hosts (Render, Fly, Cloud Run, Railway, Koyeb) assign a port at
// runtime and pass it as PORT. ASP.NET Core only reads ASPNETCORE_URLS, so
// without this bridge the app binds to its own default, the platform's health
// check never succeeds, and the deploy fails with nothing obviously wrong.
//
// 0.0.0.0 rather than localhost: inside a container the request arrives on the
// container's external interface, not the loopback.
// -----------------------------------------------------------------------------
var assignedPort = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrWhiteSpace(assignedPort)
    && string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{assignedPort}");
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
var databaseOptions = builder.Configuration.GetSection("Database").Get<DatabaseOptions>() ?? new DatabaseOptions();
var businessTimeZoneId = builder.Configuration["Business:TimeZone"] ?? "Asia/Kolkata";

builder.Services.AddSingleton(databaseOptions);
builder.Services.AddSingleton<IDbConnectionFactory>(_ =>
    new SqliteConnectionFactory(databaseOptions, builder.Environment.ContentRootPath));
builder.Services.AddSingleton<IClock>(sp =>
    new SystemClock(Clock.ResolveTimeZone(businessTimeZoneId, sp.GetService<ILogger<SystemClock>>())));
builder.Services.AddSingleton<Migrator>();
builder.Services.AddSingleton<Seeder>();

// -----------------------------------------------------------------------------
// Authentication - cookies, not JWT.
//
// Single origin, browser-only client, no third-party consumers. A cookie is
// revocable, needs no refresh dance, and cannot be read by page scripts.
// -----------------------------------------------------------------------------
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "wh.session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        // Secure in production; relaxed in development so http://localhost works.
        options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
            ? CookieSecurePolicy.SameAsRequest
            : CookieSecurePolicy.Always;

        // A counter operator should not be signed out mid-shift. Sliding
        // expiration keeps an active till alive indefinitely.
        options.ExpireTimeSpan = TimeSpan.FromDays(30);
        options.SlidingExpiration = true;

        // This host serves an API and a SPA. Answer with status codes; the
        // client decides whether to show the login screen.
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy(Policies.SignedIn, policy => policy.RequireAuthenticatedUser())
    .AddPolicy(Policies.AdminOnly, policy => policy.RequireAuthenticatedUser().RequireRole(Roles.Admin));

// -----------------------------------------------------------------------------
// Rate limiting - applied only to sign-in.
//
// The legacy app allowed 10 attempts. This is a small deployment with a handful
// of accounts, so brute force is the realistic threat and throttling costs
// nothing. Deliberately NOT applied to the sale endpoint: an operator hammering
// through a queue must never be throttled.
// -----------------------------------------------------------------------------
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("login", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(5),
                QueueLimit = 0,
            }));
});

builder.Services.AddResponseCompression(options => options.EnableForHttps = true);
builder.Services.AddProblemDetails();
builder.Services.AddEndpointModules();

// Behind Caddy/nginx: honour the real client IP so rate limiting partitions
// correctly instead of seeing every request as coming from the proxy.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // KnownIPNetworks, not the obsolete KnownNetworks (ASPDEPR005 in .NET 10).
    // Cleared because the only proxy is Caddy on this same host; anything else
    // reaching Kestrel directly should not be trusted to assert a client IP.
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();

// -----------------------------------------------------------------------------
// Startup: schema and seed data, before the first request is served.
// -----------------------------------------------------------------------------
try
{
    app.Services.GetRequiredService<Migrator>().Run();
    app.Services.GetRequiredService<Seeder>().Run();
}
catch (Exception ex)
{
    app.Logger.LogCritical(ex, "Startup failed while preparing the database. The application will not start.");
    throw;
}

// -----------------------------------------------------------------------------
// Pipeline
// -----------------------------------------------------------------------------
app.UseForwardedHeaders();

app.UseExceptionHandler(handler => handler.Run(async context =>
{
    var feature = context.Features.Get<IExceptionHandlerFeature>();
    var logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("UnhandledException");
    logger.LogError(feature?.Error, "Unhandled exception for {Method} {Path}", context.Request.Method, context.Request.Path);

    // A uniqueness violation racing two concurrent writers is a conflict, not a
    // server fault - most often the offline outbox retrying a sale whose first
    // attempt actually succeeded.
    var isConflict = feature?.Error is SqliteException { SqliteErrorCode: 19 };
    context.Response.StatusCode = isConflict ? StatusCodes.Status409Conflict : StatusCodes.Status500InternalServerError;
    context.Response.ContentType = "application/problem+json";
    await context.Response.WriteAsJsonAsync(new
    {
        title = isConflict ? "Conflict" : "Unexpected error",
        status = context.Response.StatusCode,
        detail = isConflict
            ? "This record conflicts with one that already exists."
            : "The request could not be completed. The error has been logged.",
    });
}));

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

app.UseResponseCompression();
app.UseRateLimiter();

// The SPA is served from this same host: no CORS, no second deployment, no CDN.
app.UseDefaultFiles();
app.UseStaticFiles();

app.UseAuthentication();
app.UseAuthorization();

app.MapEndpointModules();

// Liveness probe for the service manager. Anonymous and dependency-free.
app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

// Any non-API path falls through to the SPA so client-side routes survive a
// browser refresh.
app.MapFallbackToFile("index.html");

app.Run();

/// <summary>Exposed so an integration test project can drive the real pipeline.</summary>
public partial class Program;

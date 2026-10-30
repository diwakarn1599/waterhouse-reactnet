using System.Reflection;

namespace Waterhouse.Api.Infrastructure.Endpoints;

/// <summary>
/// A self-contained slice of the HTTP surface.
/// </summary>
/// <remarks>
/// This is the extension seam. To add a feature - delivery routes, suppliers,
/// GST invoicing - create a folder under Features/, add a class implementing
/// this interface, and it registers itself at startup. Program.cs does not
/// change, and no central list needs editing.
/// </remarks>
public interface IEndpointModule
{
    /// <summary>Register this module's routes.</summary>
    void MapEndpoints(IEndpointRouteBuilder app);

    /// <summary>
    /// Register this module's services. Default is a no-op so simple modules
    /// only implement <see cref="MapEndpoints"/>.
    /// </summary>
    void RegisterServices(IServiceCollection services) { }
}

public static class EndpointModuleExtensions
{
    /// <summary>
    /// Find every <see cref="IEndpointModule"/> in the assembly and register
    /// its services. Called once at startup.
    /// </summary>
    public static IServiceCollection AddEndpointModules(this IServiceCollection services)
    {
        foreach (var module in DiscoverModules())
        {
            module.RegisterServices(services);
            // Registered explicitly as IEndpointModule; relying on generic
            // inference here would silently register the concrete type instead
            // and MapEndpointModules would find nothing.
            services.AddSingleton<IEndpointModule>(module);
        }
        return services;
    }

    /// <summary>Map every discovered module's routes.</summary>
    public static IEndpointRouteBuilder MapEndpointModules(this IEndpointRouteBuilder app)
    {
        foreach (var module in app.ServiceProvider.GetServices<IEndpointModule>())
        {
            module.MapEndpoints(app);
        }
        return app;
    }

    private static IReadOnlyList<IEndpointModule> DiscoverModules()
    {
        return Assembly.GetExecutingAssembly()
            .GetTypes()
            .Where(t => typeof(IEndpointModule).IsAssignableFrom(t)
                        && t is { IsAbstract: false, IsInterface: false })
            .Select(t => (IEndpointModule)Activator.CreateInstance(t)!)
            .OrderBy(m => m.GetType().FullName, StringComparer.Ordinal)
            .ToList();
    }
}

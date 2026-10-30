namespace Waterhouse.Api.Infrastructure.Http;

/// <summary>
/// Collects field-level validation errors and turns them into a
/// ValidationProblem response.
/// </summary>
/// <remarks>
/// Hand-rolled rather than taken as a dependency. The rules this application
/// needs are a handful of range and presence checks, and a validation library
/// would be more code to keep patched than the checks themselves.
/// </remarks>
public sealed class Validator
{
    private readonly Dictionary<string, List<string>> _errors = new(StringComparer.Ordinal);

    public bool HasErrors => _errors.Count > 0;

    public Validator Add(string field, string message)
    {
        if (!_errors.TryGetValue(field, out var list))
        {
            list = [];
            _errors[field] = list;
        }
        list.Add(message);
        return this;
    }

    public Validator Require(bool condition, string field, string message)
    {
        if (!condition) Add(field, message);
        return this;
    }

    public Validator RequireText(string? value, string field, int maxLength = 255)
    {
        if (string.IsNullOrWhiteSpace(value)) Add(field, "Required.");
        else if (value.Length > maxLength) Add(field, $"Must be {maxLength} characters or fewer.");
        return this;
    }

    public Validator RequireDate(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value)) Add(field, "Required.");
        else if (!Clock.IsValidDate(value)) Add(field, "Must be a valid date in yyyy-MM-dd format.");
        return this;
    }

    public Validator RequireRange(decimal value, decimal min, decimal max, string field)
    {
        if (value < min || value > max) Add(field, $"Must be between {min} and {max}.");
        return this;
    }

    public Validator RequirePositive(int value, string field)
    {
        if (value <= 0) Add(field, "Must be greater than zero.");
        return this;
    }

    /// <summary>Returns a 400 ValidationProblem, or null when there are no errors.</summary>
    public IResult? Problem() =>
        HasErrors
            ? Results.ValidationProblem(_errors.ToDictionary(e => e.Key, e => e.Value.ToArray()))
            : null;
}

public static class ApiResults
{
    public static IResult NotFound(string what, object id) =>
        Results.Problem(title: "Not found", detail: $"{what} '{id}' does not exist.", statusCode: StatusCodes.Status404NotFound);

    public static IResult Conflict(string detail) =>
        Results.Problem(title: "Conflict", detail: detail, statusCode: StatusCodes.Status409Conflict);

    /// <summary>
    /// 422: the request was well-formed but the operation is not allowed in the
    /// current state - insufficient stock, an already-voided sale, and so on.
    /// Distinguished from 400 so the client can show the message as-is rather
    /// than attaching it to a form field.
    /// </summary>
    public static IResult Unprocessable(string detail) =>
        Results.Problem(title: "Cannot complete", detail: detail, statusCode: StatusCodes.Status422UnprocessableEntity);
}

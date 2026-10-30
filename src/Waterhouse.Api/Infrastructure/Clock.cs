using System.Globalization;
namespace Waterhouse.Api.Infrastructure;

/// <summary>
/// Time, behind an interface so tests can pin it.
/// </summary>
/// <remarks>
/// Two distinct notions of "now" are kept apart on purpose:
///
///   <see cref="NowIso"/>    UTC instant. Every <c>created_at</c> / <c>updated_at</c>
///                           column. Unambiguous, sorts correctly, survives a
///                           server timezone change.
///
///   <see cref="Today"/>     The LOCAL business date. A sale at 00:30 IST belongs
///                           to that day's takings, not the previous UTC day.
///                           Every daily report and the POS date default use it.
///
/// Storing business dates in UTC would shift a late-evening sale into the next
/// day's sheet for anywhere east of Greenwich, which is exactly where this runs.
/// </remarks>
public interface IClock
{
    DateTimeOffset UtcNow { get; }

    /// <summary>Current instant as ISO-8601 UTC, matching the storage convention.</summary>
    string NowIso();

    /// <summary>Current business date as 'yyyy-MM-dd' in the configured timezone.</summary>
    string Today();
}

public sealed class SystemClock(TimeZoneInfo businessTimeZone) : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

    public string NowIso() => Clock.NowIso();

    public string Today() =>
        TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, businessTimeZone)
            .ToString("yyyy-MM-dd");
}

/// <summary>Static helpers for the few places an injected clock is impractical.</summary>
public static class Clock
{
    public const string DateFormat = "yyyy-MM-dd";

    public static string NowIso() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");

    /// <summary>
    /// Resolve the business timezone from configuration.
    /// </summary>
    /// <remarks>
    /// Accepts either a fixed UTC offset ("+05:30") or a timezone id
    /// ("Asia/Kolkata"), and tries the offset form FIRST on purpose.
    ///
    /// The project builds with <c>InvariantGlobalization=true</c>, which strips
    /// the ICU data .NET uses to map IANA ids. Under that setting
    /// <c>FindSystemTimeZoneById("Asia/Kolkata")</c> throws, this method used to
    /// fall back to UTC, and every daily report then rolled over at UTC midnight
    /// - 5:30am local. Sales taken before 5:30am would have been counted on the
    /// previous day's sheet, quietly and forever.
    ///
    /// A fixed offset is not a workaround here, it is more correct: India has
    /// never observed daylight saving, so +05:30 is exact all year and needs no
    /// timezone database at all. Regions that DO observe DST must use an id and
    /// run with globalization enabled.
    /// </remarks>
    public static TimeZoneInfo ResolveTimeZone(string? id, ILogger? logger = null)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;

        var value = id.Trim();

        // Fixed offset: "+05:30", "-08:00", "+0530", "5:30".
        if (TryParseOffset(value, out var offset))
        {
            return TimeZoneInfo.CreateCustomTimeZone($"UTC{value}", offset, $"UTC{value}", $"UTC{value}");
        }

        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(value);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            logger?.LogWarning(
                "Timezone '{TimeZone}' could not be resolved, so dates fall back to UTC. Daily reports will " +
                "roll over at UTC midnight, which is almost certainly wrong. This build uses " +
                "InvariantGlobalization, which removes the data needed for named timezone ids - set " +
                "Business:TimeZone to a fixed offset such as \"+05:30\" instead.", value);
            return TimeZoneInfo.Utc;
        }
    }

    private static bool TryParseOffset(string value, out TimeSpan offset)
    {
        offset = TimeSpan.Zero;

        var text = value.StartsWith("UTC", StringComparison.OrdinalIgnoreCase) ? value[3..] : value;
        if (text.Length == 0) return false;

        var sign = 1;
        if (text[0] is '+' or '-')
        {
            sign = text[0] == '-' ? -1 : 1;
            text = text[1..];
        }
        else if (!char.IsDigit(text[0]))
        {
            return false;
        }

        // "0530" -> "05:30"
        if (text.Length == 4 && !text.Contains(':')) text = $"{text[..2]}:{text[2..]}";

        if (!TimeSpan.TryParse(text, CultureInfo.InvariantCulture, out var parsed)) return false;
        // A bare "5" parses as 5 days, not 5 hours.
        if (parsed.Days != 0) return false;
        if (parsed > TimeSpan.FromHours(14)) return false;

        offset = sign * parsed;
        return true;
    }

    /// <summary>True if <paramref name="value"/> is a valid 'yyyy-MM-dd' date.</summary>
    public static bool IsValidDate(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && DateOnly.TryParseExact(value, DateFormat, out _);
}

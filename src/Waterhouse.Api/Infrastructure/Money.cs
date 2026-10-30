using System.Globalization;
using System.Text;

namespace Waterhouse.Api.Infrastructure;

/// <summary>
/// Conversions between the integer paise stored in the database and the decimal
/// rupees exchanged over the API.
/// </summary>
/// <remarks>
/// Money is <c>long</c> paise everywhere inside the application and in every
/// column. It is never <c>double</c> or <c>float</c>.
///
/// The legacy schema stored money as MySQL DOUBLE. Binary floating point cannot
/// represent 0.01 exactly, so totals drifted as they accumulated across 112k
/// rows and a bill could disagree with the sum of its parts by a paisa. Integer
/// paise removes the entire class of defect: every amount is exact, and
/// addition and subtraction are exact.
///
/// Only division needs care, and there is exactly one place it occurs - the
/// per-unit rate on a legacy row that lacked one - which is why
/// <see cref="DivideRounded"/> is explicit about its rounding.
/// </remarks>
public static class Money
{
    public const long Zero = 0L;

    /// <summary>Rupees as sent by a client -> integer paise.</summary>
    /// <exception cref="ArgumentOutOfRangeException">
    /// If the value cannot be represented, which for a POS means the caller sent
    /// something absurd and the request should be rejected rather than rounded.
    /// </exception>
    public static long FromRupees(decimal rupees)
    {
        var scaled = decimal.Round(rupees * 100m, 0, MidpointRounding.AwayFromZero);
        if (scaled is < long.MinValue or > long.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(rupees), rupees, "Amount out of range.");
        }
        return (long)scaled;
    }

    /// <summary>Integer paise -> rupees for JSON responses.</summary>
    public static decimal ToRupees(long paise) => paise / 100m;

    /// <summary>
    /// Divide paise into <paramref name="parts"/>, rounding half away from zero.
    /// Use only where a per-unit figure must be derived; never to split a total
    /// that must reconcile, because the remainder is discarded.
    /// </summary>
    public static long DivideRounded(long paise, long parts)
    {
        if (parts == 0) return 0;
        return (long)decimal.Round((decimal)paise / parts, 0, MidpointRounding.AwayFromZero);
    }

    /// <summary>Indian-format display string, e.g. "12,25,831.35". No symbol.</summary>
    /// <remarks>
    /// Grouped by hand rather than via <c>CultureInfo.GetCultureInfo("en-IN")</c>.
    /// The project builds with <c>InvariantGlobalization=true</c> - which keeps
    /// the self-contained binary small and removes the need for ICU on the
    /// server - and under that setting asking for any named culture throws
    /// <c>CultureNotFoundException</c> at runtime. The lookup compiled fine and
    /// failed only when a code path actually formatted a figure.
    ///
    /// Indian grouping is the last three digits, then twos:
    /// 1234567.89 becomes 12,34,567.89.
    /// </remarks>
    public static string Format(long paise)
    {
        var negative = paise < 0;
        // Guard against long.MinValue, where negation overflows.
        var absolute = paise == long.MinValue ? (ulong)long.MaxValue + 1 : (ulong)Math.Abs(paise);

        var rupees = absolute / 100;
        var fraction = absolute % 100;

        var digits = rupees.ToString(CultureInfo.InvariantCulture);
        var grouped = GroupIndian(digits);

        return $"{(negative ? "-" : string.Empty)}{grouped}.{fraction:D2}";
    }

    private static string GroupIndian(string digits)
    {
        if (digits.Length <= 3) return digits;

        var lastThree = digits[^3..];
        var rest = digits[..^3];

        // Everything above the last three digits is grouped in twos, right to left.
        var builder = new StringBuilder();
        for (var i = 0; i < rest.Length; i++)
        {
            // A separator goes before a digit whenever an even number of digits
            // remains after it, except at the very start of the string.
            if (i > 0 && (rest.Length - i) % 2 == 0) builder.Append(',');
            builder.Append(rest[i]);
        }

        return $"{builder},{lastThree}";
    }
}

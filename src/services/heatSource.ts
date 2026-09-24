import type { Pool } from 'pg';

/**
 * The one rule that separates a fixed heat source from a fire, and the
 * helpers every consumer uses so the rule lives in exactly one place.
 *
 * Measured on the 500 most recent incidents on 2026-09-24 (see migration 011
 * for the two populations). Steelworks, refineries and gas flares sit at
 * distinct_days 7–51 / frp_mean ≤ 3.7 / max_frp ≤ 14.3; the real multi-day
 * fires of the same period at frp_mean ≥ 7.5 / max_frp ≥ 32.6. The rule
 * below leaves a margin on both sides and admits nothing from either group
 * that belongs to the other.
 *
 * WHAT THE CLASS MEANS. "This heat is coming from something that does not
 * go out." It says nothing about any fire being extinguished, and nothing
 * here may ever be read that way. It is a label, not a filter: the incident
 * stays in every list; the client draws it grey.
 *
 * WHAT IT DOES NOT DO. It cannot classify anything younger than seven
 * distinct days. A brand-new industrial source is shown as an incident for
 * its first week — the price of never hiding a week-old wildfire.
 */

export const HEAT_SOURCE_CLASS = 'persistent_heat_source' as const;

/** Seen on this many separate calendar days. Fires rarely reach this weak. */
export const HEAT_SOURCE_MIN_DISTINCT_DAYS = 7;
/** Mean radiative power over all detections, MW. Fires measured ≥ 7.5. */
export const HEAT_SOURCE_MAX_MEAN_FRP_MW = 5;
/** Peak radiative power, MW. Fires measured ≥ 32.6. */
export const HEAT_SOURCE_MAX_PEAK_FRP_MW = 20;

export interface HeatSourceInput {
  distinctDaysSeen: number | null | undefined;
  frpMean: number | null | undefined;
  maxFrpMw: number | null | undefined;
}

export interface HeatSourceVerdict {
  heatSourceClass: typeof HEAT_SOURCE_CLASS | null;
  reason: string | null;
}

/** Pure form of the rule, for tests and for anything that has the row in hand. */
export function classifyHeatSource(input: HeatSourceInput): HeatSourceVerdict {
  const days = Number(input.distinctDaysSeen ?? 0);
  const mean = input.frpMean === null || input.frpMean === undefined ? null : Number(input.frpMean);
  const peak = Number(input.maxFrpMw ?? 0);
  if (
    days >= HEAT_SOURCE_MIN_DISTINCT_DAYS &&
    mean !== null &&
    Number.isFinite(mean) &&
    mean < HEAT_SOURCE_MAX_MEAN_FRP_MW &&
    peak < HEAT_SOURCE_MAX_PEAK_FRP_MW
  ) {
    return {
      heatSourceClass: HEAT_SOURCE_CLASS,
      reason: heatSourceReason(days, mean, peak),
    };
  }
  return { heatSourceClass: null, reason: null };
}

/** The text stored beside the class: the evidence, in the order it was weighed. */
export function heatSourceReason(days: number, mean: number, peak: number): string {
  return (
    `seen on ${days} distinct days (≥${HEAT_SOURCE_MIN_DISTINCT_DAYS}), ` +
    `mean FRP ${mean.toFixed(1)} MW (<${HEAT_SOURCE_MAX_MEAN_FRP_MW}), ` +
    `peak FRP ${peak.toFixed(1)} MW (<${HEAT_SOURCE_MAX_PEAK_FRP_MW})`
  );
}

/**
 * The same rule as SQL, for the cluster job's set-based UPDATE. `alias` is
 * the fire_incidents alias in the enclosing query.
 */
export function heatSourceSqlCondition(alias: string): string {
  return (
    `${alias}.distinct_days_seen >= ${HEAT_SOURCE_MIN_DISTINCT_DAYS}` +
    ` AND ${alias}.frp_mean IS NOT NULL` +
    ` AND ${alias}.frp_mean < ${HEAT_SOURCE_MAX_MEAN_FRP_MW}` +
    ` AND COALESCE(${alias}.max_frp_mw, 0) < ${HEAT_SOURCE_MAX_PEAK_FRP_MW}`
  );
}

/** SQL for the stored reason text; mirrors heatSourceReason exactly. */
export function heatSourceReasonSql(alias: string): string {
  return (
    `'seen on ' || ${alias}.distinct_days_seen || ' distinct days (≥${HEAT_SOURCE_MIN_DISTINCT_DAYS}), ' ||` +
    ` 'mean FRP ' || round(${alias}.frp_mean::numeric, 1) || ' MW (<${HEAT_SOURCE_MAX_MEAN_FRP_MW}), ' ||` +
    ` 'peak FRP ' || round(COALESCE(${alias}.max_frp_mw, 0)::numeric, 1) || ' MW (<${HEAT_SOURCE_MAX_PEAK_FRP_MW})'`
  );
}

let columnsAvailable: Promise<boolean> | null = null;

/**
 * Whether migration 011 has been applied. Memoised for the process, like the
 * cluster job's other column checks: a deploy ahead of the migration must
 * keep every endpoint answering, just without the field.
 */
export function heatSourceColumnsAvailable(pool: Pool): Promise<boolean> {
  if (!columnsAvailable) {
    columnsAvailable = pool
      .query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'fire_incidents' AND column_name = 'heat_source_class'`
      )
      .then((r) => r.rows.length > 0)
      .catch(() => {
        columnsAvailable = null; // transient failure: ask again next time
        return false;
      });
  }
  return columnsAvailable;
}

/** For tests and for the admin path that re-checks after applying a migration. */
export function resetHeatSourceColumnCache(): void {
  columnsAvailable = null;
}

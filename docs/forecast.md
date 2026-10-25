# Forecast note

Written 2026-10-24. This is the honest scope of the forecast layer as built on
`feat/command-v3`; the contract (`contracts.ts`) is unchanged.

## What is implemented

- `engine/src/forecast.ts`: a pure ensemble. Weights are normalised, reweighted
  with a Gaussian likelihood (`sigma` 1.0 by default), and summarised by ESS.
  `resample` uses systematic resampling with 2% jitter, so survivors are not
  identical clones. `combine` returns weighted p10/p50/p90 per zone, with the
  centre taken from the weighted distribution, not the mean of variant peaks.
  `improvingShare` is the confidence number, not a typed constant.
- `app/src/sensors.ts`: synthetic observations. A zone with no coverage returns
  `null`; a dropped sample is `NaN`; samples are held for `latencyS`; noise is
  seeded, so the same seed and truth produce identical arrays.
- `app/src/dayclock.ts`: 05:00-21:00 game-day clock around a 15:30 kickoff.
- Side panels: zones (people, 15-minute trend, time to 4 p/m²), lots (occupancy
  from the density grid) and a read-only officer roster.

## What is not implemented, and why

- **No checkpoint→worker forecast loop yet.** `forecast.ts` weighs curves; it
  does not clone the simulation, vary seed/compliance/arrival/weather, or emit
  curves from `edits.ts`. That integration needs a real checkpoint/variant API,
  not a constant dressed as a forecast.
- **No map bands or ghost layer.** The p10/p50/p90 data exists; the Pixi layer
  and the observed/predicted legend do not.
- **No approve/deny, commit or decision tape UI.** These need a forecast API
  whose numbers come from the same run, not a second calculation.
- **No provider chain beyond the existing decision client.** Cache → Kev →
  defaults already reports `source`; a heuristic logit and monotonicity test
  remain open.
- **No skill claim.** There is no truth-vs-forecast MAE while the loop above is
  missing. Do not present the ensemble output as calibrated.

## Sizing and calibration

The old plan suggested six 600 s variants at 5k dots. That spike was not run
because the worker integration does not exist; the pure ensemble is cheap and
does not justify a variant count by itself. When the loop is built, start with
five variants (centre, seed, compliance, arrival shift, weather), measure wall
time, and drop to four if a 600 s horizon exceeds 1.5 s. Report p10/p50/p90 and
the measured improving share; never label them observations.

## Claim rules

- A forecast is a model output. Say "forecast", not "will happen".
- A zone with `null` coverage is inferred, not measured; render it differently.
- Peak density on a plan card is the maximum centre across variants, not the
  mean of variant peaks.
- Any score shown next to approve/deny must come from the forecast API; a
  parallel app-side calculation is a bug.

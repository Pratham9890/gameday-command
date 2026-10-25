Pushed successfully to feat/police-ops at commit 9ea3051. The remote commit is verified. No report or PR was added. The changes are on that feature branch; main remains unchanged.

What I implemented:
- Working police responses. Responding officers walk a reachable outdoor route, give repeated crowd instructions, work for three simulated minutes after arrival, and return to their original posts. Instructions rank open gates using queue clearance and walking cost. Arrival times and mission progress survive rewind.
- Traffic control. Officers on traffic-response assignments alternate junction entry directions, with clearance intervals. Emergency vehicles are exempt. This changes vehicle movement rather than merely displaying an officer marker.
- Dispatch suggestions. Nearby hotspots merge into ranked suggestions. The system prefers available or patrolling units, protects the last unit at a critical hotspot, and uses worker-calculated walking ETAs. Added Dispatch suggested units, individual Send and return, target changes, dismissal cooldowns, and assignment status.
- Patrols. Added deterministic outdoor beats generated from the map, a gate fallback for road-free maps, patrol interruption, resume controls, and replay support.
- Unit placement. Added synthetic officers with deterministic IDs, removal controls, and checkpoint/replay handling.
- Coverage. Added current officer-reach overlays in both map views, an outdoor-area coverage percentage, uncovered-hotspot counts, and route drawing.
- Demo roles. Added skippable demo sign-in, supervisor/officer selection, unit selection, reduced-motion support, and role switching within the same run. The new sign-in storage contains only role and unit.
- Officer console. Added assignment details, acknowledgement, simulated status indicators, camera-follow controls, nearby walking ETAs, backup requests, and map-based incident reports. Supervisor controls are hidden and guarded in this mode.
- Roadblocks and markers. Added vehicle-only barriers, pedestrian-only fencing, removal, click-based move/resize, roadblock lists, and observed stopped-vehicle counts within 50 metres. Added staging, medical and PA markers; PA markers can define an alert’s radius.
- Recorded motion. Added intermediate movement samples and path playback to reduce straight-line rendering through corners between simulation frames.
- Imported-stadium routing and parking. Added wider walking-route preferences near buildings, explicit parking connectors, capacity-based traffic counts, and alternate reachable entry selection.
- Lightning performance. Replaced exhaustive shelter-cell searches with an exact spatial index that preserves eligibility and original tie-breaking.
The main changes are in the simulation, traffic, flow-field and worker modules; the police panel, suggestions, coverage and officer console; map rendering; and new regression tests and diagnostic scripts.

What the tests actually showed:
Check	Result
Full suite before the final Ohio compatibility adjustment	348 passed, 3 skipped
Traffic checks after that adjustment	19 passed
Final TypeScript check	Passed with no diagnostics
Production build before that final adjustment	Passed; large-chunk warning remains
Lightning performance in the full test run	16.3× real time
Baseline crowd fingerprints, 24/60 officers, traffic on/off	All identical before and after


With motion recording enabled, final traffic benchmarks measured 5.20 ms/s with 24 officers and 5.13 ms/s with 60 officers, versus earlier references of 4.57 and 4.82. These are local measurements taken at different times, not a controlled browser-performance certification.

For Wembley’s saved map:
- It contains 117 mapped surface parking stalls, so the app now schedules 99 synthetic vehicles instead of blindly scheduling 4,500.
- Reachable entry selection increased parked vehicles from 73 to 90 out of 99 in the comparable capacity-based test.
- Wider routes reduced the measured stationary outdoor crowd from 10,730 to 4,950 people.
- Accepting suggested responses once produced 2,470 people instructed, 1,300 following, and 58,910 seated, compared with 58,405 seated in the original run.
- The danger-minutes score increased about 2.6% in that response experiment. Therefore, the results establish changed behaviour and fewer stationary people—not an overall safety improvement.
The stricter connectors also caused an Ohio traffic regression during testing. The pushed code preserves Ohio’s calibrated parking approaches; its final benchmark returned to the original 65 stopped / 1,360 out figures.

What still needs implementation or testing:
1. Complete vehicle physics remains the largest unfinished item. Full rectangular collision enforcement, parking drive aisles, collision-safe stall entry and departure, reversing, departure staggering, turning-radius limits, and squeeze counters/visual indicators are unfinished. I cannot claim cars never overlap or clip buildings.
2. Incident resolution is limited. Officers influence crowds and traffic. Medical incidents, fights and suspicious items do not yet have a separate resolution lifecycle that completes when officers arrive.
3. Routing needs broader stadium validation. Wembley improved, but some stationary congestion remains. Test several imported stadiums through arrivals, parking, closures and departures. Ohio still uses its older driveway behaviour until the stricter connector model can be generalized without regression.
4. Coverage is partial. Current reach and hotspot walking ETAs exist. The requested “reachable within N minutes” coverage grid, uncovered-area hatching, complete beat geometry and additional response readouts remain unfinished.
5. Suggestions need fuller auditing. Expiration logging, optional dismissal-reason controls, hotspot-duration tracking and richer descriptions of which posts become uncovered remain unfinished. The measured arrival statistic currently starts at dispatch, not initial suggestion creation.
6. Officer mode uses the allowed same-tab fallback. Two-window synchronization through BroadcastChannel is not implemented. Camera following, phone-width layout, focus handling and request workflows still need browser verification.
7. Roadblock placement is click-based. True click-drag endpoints are unfinished. The reach control can include connected junction branches. Distinct barrier-kind artwork in 2D, longer pedestrian fences, changing an existing barrier’s kind, and additional rewind combinations need work/testing. Stopped-nearby counts do not prove vehicles were held by that particular barrier.
8. A dedicated manual traffic-control-point tool remains unfinished. The traffic effect currently comes from traffic-response assignments.
9. Browser QA remains outstanding. Check desktop and 390-pixel layouts, both themes, vehicles at 20×/60×, patrols, automatic returns, placement, role switching, reports, and rewind. Browser access is still denied for this chat.
10. Final release checks remain. Rerun the complete suite and production build on the pushed commit after the last compatibility adjustment. Measure three simultaneous browser workers, rendering performance, and active responses with 24 and 60 officers. The three live-model tests were skipped.
11. Optional M7 features were not implemented: after-action exports, undo orders, hotspot watch, shortcuts, fatigue indicators and audio cues.

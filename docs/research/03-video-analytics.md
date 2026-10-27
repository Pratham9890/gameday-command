# 03 — Video analytics: crowd density, flow and vehicles from video

Research note for Gameday Command v3, 2026-10-26. Video goes in. Counts, densities and flows per zone come out. Never faces or identities.

Numbers marked **measured** come from throwaway experiments in `/projects/sandbox/.scratch/vision/`, which is outside the repo. The test machine was an Intel Xeon 8488C VM (8 vCPU, no GPU) running onnxruntime 1.31.1, and onnxruntime-web 1.31.1 in headless Chrome 151. The command-post Mac will differ and must be measured (VID-26).

## Summary

- **Where it runs:** a browser Vision Worker.
  - Frames come from `<video>` + `requestVideoFrameCallback` (files, HLS, WebRTC) or from `getUserMedia` (webcam, capture card).
  - RTSP cameras go through a local MediaMTX bridge (MIT).
  - Inference uses onnxruntime-web (MIT): WebGPU first, WASM as fallback.
  - Only zone aggregates leave the worker, never pixels.
- **Models:**
  - Primary: **DM-Count** (MIT, density map), the only candidate with permissive code, downloadable weights and a simple graph. **Measured:** ONNX opset 17, 43 MB at FP16, PyTorch parity to 4×10⁻⁶.
  - For sparse areas and vehicles: **YOLOX** (Apache-2.0, trained on COCO only), or RT-DETR-R18 where accuracy matters more.
  - Ultralytics (AGPL-3.0) is excluded.
- **Licence risk, plainly:** every published crowd-counting weight was trained on research-only or unlicensed datasets, starting from non-commercial ImageNet backbones. **Fine for evaluation and demos. Production needs retraining on owned or licensed data, or a licence.**
- **Speed (measured):**
  - DM-Count at 512×288 takes 213 ms natively and 966 ms in browser WASM (4 threads). That is roughly one estimate per camera every few seconds.
  - WebGPU could not be timed here.
  - YOLOX-Nano takes 41 ms but finds nobody in a crowd DM-Count puts at about 380.
- **Accuracy depends on geometry:** a homography from clicked map points, a head-height correction (otherwise 6 m of error at 30 m), count-preserving projection into the engine's 2 m cells, and per-cell fusion of overlapping cameras.
- **Simulation:**
  - First, emit the existing `Conditions` JSON.
  - Then, send `ZoneObservation`s with p10/p50/p90 bands into `engine/src/forecast.ts`, recorded on an observation tape so runs replay.
- **Professional practice:**
  - Analytics triages for a human: alert → verify on camera → decide → log.
  - Each camera is validated and health-checked.
  - Use is audited under a written policy.

## 1. Models

### 1.1 Crowd counting / density maps

The table gives MAE as each benchmark reports it on its test set; "–" means not reported. SHA/SHB = ShanghaiTech A/B; QNRF = UCF-QNRF; NWPU = NWPU-Crowd.

| Model | Code licence | Weights | MAE SHA / SHB / QNRF / NWPU | Size | ONNX export |
|---|---|---|---|---|---|
| [DM-Count](https://github.com/cvlab-stonybrook/DM-Count) (2020) | MIT | Google Drive; [LWCC mirror](https://github.com/tersekmatija/lwcc_weights/releases) | 59.7 / 7.4 / 85.6 / 88.4 | 21.5 M params, 86 MB | **done, verified** |
| [CSRNet](https://github.com/leeyeehoo/CSRNet-pytorch) (2018) | none stated | Google Drive | 68.2 / 10.6 / – / 121.3 | 65 MB | likely |
| [SFANet](https://github.com/pxq0312/SFANet-crowd-counting) (2019) | none stated; [M-SFANet](https://github.com/Pongpisit-Thanasutives/Variations-of-SFANet-for-Crowd-Counting) GPL-3.0 | via LWCC | 60.4 / 6.4 (repo) | 68 MB | likely |
| [Bayesian Loss](https://github.com/ZhihengCV/Bayesian-Crowd-Counting) (2019) | GPL-3.0 (README) | Baidu / Google Drive | 62.8 / 7.7 / 88.7 / 105.4 | ≈86 MB | likely |
| [P2PNet](https://github.com/TencentYoutuResearch/CrowdCounting-P2PNet) (2021) | academic research only | SHA, in repo | 52.7 / 6.3 / 85.3 / 77.4 | VGG-16-BN | likely; licence blocks use |
| [CLTR](https://github.com/dk-liang/CLTR) (2022) | MIT | NWPU video model only | 56.9 / 6.5 / 85.8 / 74.3 | ResNet-50 + transformer | plausible |
| [STEERER](https://github.com/taohan10200/STEERER) (2023) | MIT | OneDrive (SHB, QNRF, JHU, NWPU…) | 54.5 / 5.8 / 77.8 (repo) / 63.7 | HRNet or VGG-19 | plausible |
| [PET](https://github.com/cxliu0/PET) (2023) | MIT | Google Drive | 49.1 / 6.2 (repo) | VGG-16-BN + quadtree | hard (input-dependent control flow) |
| [LWCC](https://github.com/tersekmatija/lwcc) (library) | MIT; each wrapped model keeps its own licence | GitHub release | its DM-Count: 61.4 / 7.7 / 89.0 | 65–86 MB | n/a |
| [MobileCount](https://github.com/ChenyuGAO-CS/MobileCount) (2020) | none stated | none linked | 89.4 / 9.0 / 131.1 / – | MobileNetV2-based | feasible |

LWCC's networks are full-size despite the name, and no small counter has both a licence and weights. MobileCount, for example, costs accuracy (SHA MAE 89 vs 60) and has no licence.

**Training data is the binding constraint:**
- **ShanghaiTech:** the [repo](https://github.com/desenzhou/ShanghaiTechDataset) is BSD-2-Clause, but per the [paper](https://www.cv-foundation.org/openaccess/content_cvpr_2016/papers/Zhang_Single-Image_Crowd_Counting_CVPR_2016_paper.pdf), Part A images were crawled from the internet (third-party copyright). Part B was shot on Shanghai streets. Unclear; research-only.
- **UCF-QNRF:** the [dataset page](https://www.crcv.ucf.edu/data/ucf-qnrf/) states no licence, and the images come from the web. Unclear; research-only.
- **JHU-CROWD++:** [academic and non-commercial only](http://www.crowd-counting.com/terms-of-use.html#terms-of-use), with no commercial derivative works.
- **NWPU-Crowd:** [academic and non-commercial only](https://www.crowdbenchmark.com/nwpucrowd.html), with no redistribution and no commercial derivatives.
- **ImageNet:** almost every backbone here starts from it, and its terms allow [non-commercial research and education](https://image-net.org/download-images.php) only.

It is unsettled whether weights are derivative works, and this note does not decide it. None of these terms lists operational police use.

### 1.2 Detection (sparse crowds, vehicles)

| Model | Licence | COCO AP | Measured ONNX |
|---|---|---|---|
| [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) Nano / Tiny / S | Apache-2.0; official ONNX | 25.8 / 32.8 / 40.5 | 3.7 / 20.2 / 35.9 MB, opset 11 |
| [RT-DETR-R18](https://github.com/lyuwenyu/RT-DETR) | Apache-2.0 (also the [HF weights](https://huggingface.co/PekingU/rtdetr_r18vd)) | 46.5 (49.2 with Objects365) | [ONNX build](https://huggingface.co/onnx-community/rtdetr_r18vd): 82.6 MB (41.4 MB at FP16), opset 16, NMS-free |
| [D-FINE-N](https://github.com/Peterande/D-FINE) | Apache-2.0 | 42.8 | 15.3 MB (7.9 MB at FP16) |
| [RTMDet-tiny](https://github.com/open-mmlab/mmdetection/tree/main/configs/rtmdet) | Apache-2.0 | 41.1 | not tested |
| [Ultralytics YOLO](https://github.com/ultralytics/ultralytics) | **AGPL-3.0: avoid** | – | – |

Match boxes across frames for vehicles only. Use [ByteTrack](https://github.com/ifzhang/ByteTrack) or [OC-SORT](https://github.com/noahcao/OC_SORT) (both MIT). [SORT](https://github.com/abewley/sort) is GPL-3.0, so avoid it.

The detector weights are trained on COCO. COCO's [annotations are CC BY 4.0, but the images stay under their Flickr owners' terms](https://github.com/cocodataset/cocoapi/issues/551). YOLOX is [trained from scratch on COCO](https://arxiv.org/abs/2107.08430) with no ImageNet pre-training, which makes it the cleanest detector licence story.

### 1.3 Measured sanity checks

No ground truth here; these check plausibility only.

- **Export:** the output is `[1,1,h/8,w/8]` for input `[1,3,h,w]`. FP16 moves the count 0.005%. Dynamic INT8 is 21.6 MB but slower (289 vs 213 ms), so it is not used.
- **[London Stadium photo](https://commons.wikimedia.org/wiki/File:London_Stadium_crowd_control.jpg)** (Egghead06, CC BY-SA 4.0): a dense standing crowd, a few hundred by eye.
  - DM-Count: 376–390 with any weights.
  - YOLOX-S: 386 boxes above 0.3 before NMS, 72 after.
  - RT-DETR-R18: 9 at score 0.3.
  - YOLOX-Nano, D-FINE-N: about 0.

  Occlusion and NMS defeat detectors in dense crowds.
- **[Ohio Stadium bowl photo](https://commons.wikimedia.org/wiki/File:Ohio_Stadium_during_OSU_vs_Purdue_11-13-21.jpg)** (Quintin Soloviev, CC BY 4.0): tens of thousands of people visible.
  - DM-Count-QNRF: 1,807 / 5,532 / 8,609 at 1024 / 2048 / 3520 px.
  - SHB weights: 109.

  Whole-bowl views are unusable, and every camera needs its own validation.

**Recommendation:**
- **Primary:** DM-Count, with weights picked per camera by validation MAE (QNRF for gates and plazas, SHB for sparse streets).
- **Fallback (sparse people, vehicles):**
  - YOLOX-S: fast (64 ms native, 266 ms WASM) and trained on COCO only.
  - RT-DETR-R18: worth about 2× the compute when its higher AP matters.
  - YOLOX-Nano: when compute is tight.
- **Licence-clean path:** retrain the MIT code on owned, policy-approved footage plus our synthetic renders (§9), or fit per-site regressors from manual counts ([privacy-preserving counting](https://iacl.ece.jhu.edu/proceedings/cvpr2008/papers/229.pdf)).

## 2. Running it in the browser

- **[onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html) (MIT)** provides `wasm`, `webgpu` and `webnn` backends.
  - WASM threads need cross-origin isolation, so the Vite and Hono servers must send COOP/COEP headers.
  - Its proxy worker cannot use WebGPU, so import ORT inside our own worker.
  - WebGPU [now ships in all major browsers](https://web.dev/blog/webgpu-supported-major-browsers): Chrome/Edge 113, Firefox 141 on Windows, Safari 26.
- **Measured timings** (headless Chromium, cross-origin isolated):

| Model / input | Native ORT, 4 threads | ORT-web WASM, 4 threads | WASM, 1 thread |
|---|---|---|---|
| DM-Count 512×288 | 213 ms | 966 ms | 3,652 ms |
| DM-Count 768×432 | 501 ms | 2,157 ms | – |
| DM-Count 1024×576 | 883 ms | 3,818 ms | – |
| YOLOX-Nano 416² | 7.6 ms | 41 ms | 73 ms |
| YOLOX-S 640² | 64 ms | 266 ms | – |
| RT-DETR-R18 / D-FINE-N 640² | 144 / 46 ms | not run | – |

- **WebGPU:** both graphs ran on the [WebGPU backend](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) through SwiftShader, so every operator is supported. Those timings are software emulation, so the Mac's GPU still has to be timed.
- **Alternatives:**
  - [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) wraps ORT and [caches models](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/pipelines.md). It is handy for RT-DETR and D-FINE, but DM-Count does not need it.
  - [TF.js](https://github.com/tensorflow/tfjs) would need an ONNX→TF→TF.js conversion, so it is not chosen.
- **Frames:**
  - `requestVideoFrameCallback` ([Chrome 83, Safari 15.4, Firefox 132](https://groups.google.com/a/mozilla.org/g/dev-platform/c/lp_5RctznkM)) fires once per presented frame.
  - Transfer an `ImageBitmap` or `VideoFrame` to the worker, resize it on an `OffscreenCanvas`, then close it.
  - [`MediaStreamTrackProcessor`](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing) (Chromium 94+) feeds camera frames straight to a worker.
  - [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3) plus `VideoDecoder` gives frame-exact seeking in files.
  - **Measured:** all of these are present in the sandbox Chromium; WebNN is not.
- **Budget:** density every 2–5 s per camera, and flow at 2–5 Hz on 320–480 px greyscale frames, in 10 s windows (assumption). Drop late frames rather than queueing them.
- **Downloads (measured):**
  - Sizes: WASM runtime 14.8 MB (3.8 MB gzipped), WebGPU build 28.7 MB (7.1 MB gzipped), DM-Count FP16 43 MB.
  - Serve them from our own origin, pinned by SHA-256.
  - Cache in the [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache) or [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), with persistent storage.
  - Under `GOAL.md`'s heavy-dependency rule, this needs a decision record.

## 3. Geometry: pixels to people per m²

- **Homography.** On a paused frame, the user clicks ≥4 points (6–10 is better), then the same points on the georeferenced map.
  - Store the points in world metres (x east, y south) with the map id; lat/lon converts via `makeProjection`.
  - Solve with normalised DLT + RANSAC: [OpenCV `findHomography`](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html), or roughly 100 lines of TS (estimate).
  - Reject near-collinear point sets, show the residual in metres, and draw the camera's footprint on the map.
- **Heads are not feet.** Annotations mark heads, about h = 1.7 m above the ground. The ground homography therefore pushes a person d metres away outward by d·h/(H−h), where H is the camera height. For H = 10 m (our arithmetic) that is 6.1 m at 30 m and 12.3 m at 60 m.
  - MVP fix: shift each density pixel down by one local body height.
  - Better fix: build a head-plane homography from the vertical vanishing point, using two vertical references ([single-view metrology](https://courses.engr.illinois.edu/cs543/sp2011/sources/criminisi00.pdf)).
- **Density → people/m².** Each output pixel covers 8×8 input pixels.
  - Project its foot-corrected centre and add its *count* to the 2 m cells it covers, then divide by 4 m². Totals are conserved.
  - If a pixel covers more than ~16 m² (assumption), aggregate to coarser cells and flag them.
  - Mask the horizon, and anything below 25 px/m, the IEC 62676-4 "detect" level ([Axis](https://whitepapers.axis.com/download/wp_pixel_density_based_on_iec_62676_4_2014_t10176489_2604.pdf)), to be tuned. A 1920 px, 90° camera drops below that at about 38 m (960 px ÷ distance, ignoring tilt).
- **Zones.**
  - A zone's count sums its covered cells and is reported with its coverage fraction.
  - Below ~30% coverage (assumption) the zone is "partial" and gets a wider band.
  - An uncovered zone is `null`, not 0, matching `app/src/sensors.ts`.
- **Overlap.** Fuse per cell by inverse variance, favouring the camera with more px/m. Never sum counts across cameras; this de-duplicates without identifying anyone.
- **Uneven ground and stands.**
  - A point δz off the calibrated plane shifts by about d·δz/(H−δz): 4.4 m for a 1 m rise 40 m from a 10 m camera.
  - Use one homography per flat patch, including each stand section's slope.
  - Stands are low priority: the engine already treats seated fans as safe (`standingPerM2` in `boards.ts`).
  - Undistort wide lenses first.
  - PTZ moves break calibration, so use fixed presets.

## 4. Motion and "other things"

- **Optical flow.**
  - **Measured:** OpenCV.js Farneback ([@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js), Apache-2.0, 13.3 MB, 3.7 MB gzipped) takes 38 / 68 / 151 ms per frame pair at 480×270 / 640×360 / 960×540 (Node WASM, 1 thread). Native code takes 25 / 44 / 99 ms.
  - **Measured:** on a [CC BY 2.5 pedestrian video](https://commons.wikimedia.org/wiki/File:Traffic-Instabilities-in-Self-Organized-Pedestrian-Crowds-pcbi.1002442.s004.ogv) at 60 fps, 90th-percentile motion was only 0.06 px per frame over the first 120 frames. Choose the frame gap adaptively so motion is 1–8 px (assumption).
  - Learned flow ([RAFT](https://github.com/princeton-vl/RAFT), [SEA-RAFT](https://github.com/princeton-vl/SEA-RAFT): BSD-3; [NeuFlow v2](https://github.com/neufieldrobotics/NeuFlow_v2): Apache-2.0) ships weights trained on FlyingChairs/Things, whose [terms forbid commercial use](https://github.com/tensorflow/datasets/issues/639).
  - A small Lucas–Kanade in Rust/WASM is the low-dependency option.
- **Velocity field:** pixel flow → m/s via the homography's local Jacobian, density-weighted per cell.
- **Line flow:** q = Σ ρ·(v·n)·L over line segments, split in/out.
  - This is density × velocity [crossing-line counting](https://explore.ee.cuhk.edu.hk/~xgwang/papers/ZhaoLZWeccv16.pdf), so no one is tracked.
  - Calibrate against gate scans.
- **Queues:** L = count in the queue polygon. With measured service rate λ, wait W ≈ L/λ ([Little's law](https://doi.org/10.1287/opre.9.3.383); assumes steady state).
- **Stationary crowd:** density above threshold and speed < 0.1 m/s (the stop speed used by Helbing et al.) for > 60 s (assumption).
- **Counterflow:** density-weighted share of motion more than 120° off the dominant direction (assumption).
- **Crowd pressure:** P = ρ·Var(v) ([Helbing, Johansson & Al-Abideen 2007](https://arxiv.org/abs/physics/0701203)).
  - At Jamarat, turbulence began once P passed 0.02 s⁻².
  - The value depends on the smoothing radius.
  - Their data came from calibrated tracking on good fixed cameras.
- **Rapid dispersal:** positive divergence plus a jump in mean speed. Set thresholds on test data.
- **Vehicles:**
  - Count car, bus, truck and motorcycle detections inside road polygons.
  - "Stopped" = a matched box moving < 0.5 m/s for > 60 s (assumptions).
  - No plates, no cross-camera matching.
  - Output goes to `Conditions.streets`.

| Signal | Show a commander? | Caveats |
|---|---|---|
| Zone count / density, with range | Yes | domain shift; night, rain, glare; occlusion |
| Density trend | Yes | more robust than the level |
| Flow direction / speed | Yes | camera shake, compression |
| Line flow (people/min) | Yes, after checking against scans | bias drifts with light and crowd type |
| Queue / estimated wait | Yes, as a range | assumes steady state |
| Stationary, counterflow | Yes, as "check camera" flags | tailgaters and seated groups trigger them |
| Vehicle counts, stopped vehicles | Yes | parked vs stopped; headlights |
| Crowd pressure, turbulence | No: analyst / after-action only | noise-dominated at CCTV resolution; threshold does not transfer |
| Rapid dispersal / running | Only as a "verify on camera" alert | false positives from PTZ, shake, lighting |

## 5. Ingest

- **File.** `<input type=file>`, then an object URL, then `<video>`. MP4/H.264 and WebM decode natively, so no ffmpeg is needed (the sandbox has none).
- **Webcam or capture card.** Use `getUserMedia`; UVC capture cards appear as cameras. This needs a secure context and permission.
- **HLS.** [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0; light build 386 KB, **measured**), for when the video management system (VMS) publishes HLS.
- **WebRTC.** Lowest latency. WHIP is [RFC 9725](https://www.rfc-editor.org/info/rfc9725/). WHEP is [still a draft](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep) (-04, June 2026), but MediaMTX implements it.
- **RTSP IP cameras.** Browsers can't play RTSP. [MediaMTX](https://github.com/bluenviron/mediamtx) (MIT) is a single dependency-free binary that repackages RTSP as WebRTC or HLS without ffmpeg. It has built-in authentication and metrics.
  - Run it on the command-post Mac or a LAN box.
  - Set camera sub-streams to H.264.
  - Turn recording off.
  - Bind it to the camera network and localhost.
  - [go2rtc](https://github.com/AlexxIT/go2rtc) (MIT) is an alternative.
  - Path: camera → RTSP → MediaMTX → WHEP or LL-HLS → `<video>` (see the pipeline below).

## 6. Privacy and policy by design

What "counts only" means concretely:
1. **Frames stay in the worker.** Frames exist only in the Vision Worker and are closed after use. The vision module never calls `MediaRecorder` or `toBlob`/`toDataURL`, and never writes pixels to IndexedDB, OPFS or the network. A test enforces this.
2. **No individual data.** No face detection, crops, embeddings, re-identification, cross-camera tracking, plate reading, or age/gender/emotion attributes (some vendors sell these). Person boxes never leave the worker.
3. **Coarse output.** Density leaves only as smoothed cells of 2 m or more. Below 0.5 p/m² (assumption), only zone totals leave, so no lone person appears on the map.
4. **Lowest workable resolution.** Analyse at the lowest pixel density that is accurate enough, and avoid exceeding the IEC 62676-4 "recognition" level (125 px/m). Never zoom a PTZ camera for analytics.
5. **Aggregates only.** Keep 10 s zone aggregates for an agency-set period shown in the UI. Calibration stores point pairs, not images, unless an operator opts in to a blurred still.
6. **Labels.** Every derived number reads "Video estimate · counts only · not recorded".
7. **Access control.** Roles to view, calibrate and export. An append-only audit log records who viewed which feed and when, plus calibration and model changes and exports.
8. **Model cards.** One per model: training data, licence, per-camera validation, failure modes.

Public guidance to consider (this is not legal advice):
- **US state facial-recognition laws.** Several states regulate police use of facial recognition, e.g. [Maine](https://mainelegislature.org/legis/statutes/25/title25ch701.pdf), [Montana SB 397 (2023)](https://leg.mt.gov/content/Committees/Interim/2023-2024/Law-and-Justice/Meetings/september-2023/SB397-2023.pdf) and [Virginia](https://rga.lis.virginia.gov/Published/2025/RD703/PDF). In 2022 [CDT counted more than a dozen](https://cdt.org/insights/limiting-face-recognition-surveillance-progress-and-paths-forward/).
- **Ohio.** The state's face database operates under [OHLEG rules](https://files.ohleg.org/general/OHLEG_Rules_Regulations.pdf), and an [Attorney General task force](https://www.ohioattorneygeneral.gov/Files/Briefing-Room/News-Releases/AG-Facial-Recognition-Task-Force-Report-FINAL) has reviewed it. This tool uses none of that; document that it *cannot* do face recognition.
- **[IACP Technology Policy Framework](https://www.theiacp.org/sites/default/files/all/i-j/IACP%20Technology%20Policy%20Framework%20January%202014%20Final.pdf) (2014).** Specify the use, minimise data, set retention and access, be transparent, audit, train.
- **[EU AI Act Art. 5](https://eur-lex.europa.eu/eli/reg/2024/1689/oj)** (reference point only; [applies since 2 Feb 2025](https://fpf.org/blog/red-lines-under-the-eu-ai-act-understanding-prohibited-ai-practices-and-their-interplay-with-the-gdpr-dsa/)). It bans police real-time remote biometric identification in public spaces (narrow exceptions), categorisation by sensitive traits, and untargeted face scraping. Counting touches none of these.
- **UK [Surveillance Camera Code](https://www.gov.uk/government/publications/update-to-surveillance-camera-code/amended-surveillance-camera-code-of-practice-accessible-version) (2022).** A model for transparency and review.
- **Ohio public records law.** Aggregates and audit logs may be public records under [R.C. 149.43](https://codes.ohio.gov/ohio-revised-code/section-149.43). Ask counsel.

## 7. How professional systems work, and what this app should copy

- **Edge analytics, metadata out.** Mature sites count on the camera or in the VMS and ship metadata, not video.
  - [AXIS Object Analytics](https://www.axis.com/for-developers/axis-object-analytics-counting-data) counts objects crossing a line or inside an area.
  - [ONVIF Profile M](https://www.onvif.org/profiles/profile-m/) standardises analytics metadata and events. Its [stream also carries PTZ position](https://www.onvif.org/wp-content/uploads/2022/05/onvif-profile-m.pdf), which reveals a moved camera.
  - Accept such counts as another `source`, and drop any face or body attributes.
- **A human verifies before acting.** Control rooms work alert → operator checks the camera → decision → log. Helbing et al. found watching live video poor at spotting critical density, so computed density helps. But alerts must be few, prioritised and acknowledged (alarm management in the spirit of [ISA-18.2](https://isa.org/standards-and-publications/isa-standards/isa-18-series-of-standards)).
- **Safety frameworks.** The [Green Guide, 6th edition](https://sgsa.org.uk/green-guide/) added "Zone Ex", the arrival and departure area outside the stadium, which is exactly our map. SGSA's [control-point guidance](https://sgsa.org.uk/document/control-points/) covers the room the tool runs in.
- **Camera planning.** The IEC 62676-4 DORI levels (25 / ~62 / 125 / 250 px/m) tell you whether a camera can count before you buy it.
- **Validation and health.**
  - Accept each camera on at least 30 hand-counted frames across densities (assumption), plus a line-flow check against turnstile scans. Repeat after any move.
  - Check continuously for frozen, dark, defocused or moved views.
  - On failure, show "inferred", never stale numbers.
- **Governance.**
  - A written use policy (IACP), [NIST AI RMF 1.0](https://www.nist.gov/itl/ai-risk-management-framework) (govern, map, measure, manage) and operator training.
  - For cameras bought with federal grants, [2 CFR 200.216](https://www.law.cornell.edu/cfr/text/2/200.216) (NDAA §889) excludes certain vendors.

## 8. Feeding the simulation

**Without assimilation (do first):**
- **Conditions feed:** emit `Conditions` JSON with `source: "Video estimate (Cam 12)"`.
  - `gates[].waiting` comes from queue polygons and `roads[].stopped` from vehicles.
  - The brief already reads this format, compares it with history and shows its age.
- **Start state:** build `SimConfig.startFrom`, which the contract already says is "later: built from sensor zone counts".
  - Place dots (5 fans each) in observed zones' walkable cells.
  - Unobserved zones keep the simulated prior.
- **Calibration:** fit arrival curves from cumulative gate-line counts, and set each gate's `throughputPerMin` from line flow.

**With assimilation:**
- **Observation model:** hₖ(x) = simulated density × 4 m², summed over the zone's *covered* cells only.
  - The likelihood is Gaussian, with σ² = σ_obs² + σ_model² and σ_obs ≈ (p90 − p10)/2.56.
  - Bands come from per-camera validation (a fitted σ(count) or [split-conformal intervals](https://arxiv.org/abs/2107.07511)).
- **Ensemble:** variants run from engine checkpoints with varied seed, arrival shift, compliance and gate rate; `docs/forecast.md` suggests about 5.
  - Extend `reweight` to a vector of zone observations: sum log-likelihoods, skip null/NaN, resample when ESS < N/2.
  - Rejuvenate by perturbing parameters and re-running from the checkpoint, not by the ±1% curve scaling in `resample`.
  - With so few members, an ensemble Kalman update of the parameters may beat a particle filter. See [Ward et al. 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC4852637/) and [EnKF at Grand Central (2024)](https://royalsocietypublishing.org/doi/10.1098/rsos.231553). The [particle filter of Malleson et al. 2020](https://www.jasss.org/23/3/3.html) needed many particles. Test both.
- **Reproducibility:** record every observation on an **observation tape**. The same seed + decision tape + observation tape must give the same run.

## 9. Testing without stadium footage

- **Openly licensed clips.**
  - [Wikimedia Commons](https://commons.wikimedia.org/wiki/Commons:Licensing) carries free licences only; check and credit each file. The Moussaïd et al. pedestrian videos are CC BY 2.5.
  - [Jülich's pedestrian dynamics archive](https://ped.fz-juelich.de/da/doku.php) pairs experiment videos with trajectories, which gives exact flow and line-count truth. Research use is welcome if you name the source; check each dataset's DOI.
  - [Pexels](https://help.pexels.com/hc/en-us/articles/360042332714-What-are-the-rules-for-using-Pexels-photos-or-videos) and [Pixabay](https://pixabay.com/service/license-summary/) are free to use, but they restrict depictions of identifiable people and standalone redistribution. Fetch their clips by URL and hash at test time and never commit them.
- **Synthetic video from our own simulation.** Render dots as human billboards from a virtual camera with a known homography. Per-cell truth is exact, which suits tests of geometry, fusion, lines and assimilation. Because of the domain gap, it does not measure real-world accuracy, but it is licence-clean pretraining data.
- **Metrics.**
  - Per-zone MAE, RMSE (papers call it "MSE") and NAE (MAE ÷ true count).
  - Flow error over 1–5 min windows.
  - Calibration: the share of true values inside p10–p90 (target about 80%), and [CRPS](https://doi.org/10.1198/016214506000001437).
  - Record all of these per model version and camera.

## Recommended pipeline (v3)

```
SOURCES                                  COMMAND-POST MAC (everything on-device)
IP camera ──RTSP──▶ MediaMTX ──WHEP / LL-HLS──┐
Webcam / capture card ──getUserMedia──────────┤
File (MP4/WebM) ──<video> / VideoDecoder──────┤
Edge counts (ONVIF M / MQTT) ─────────────────┼──────────────────────────────┐
                                              ▼                              │
            Main thread: rVFC → VideoFrame / ImageBitmap (transferred)       │
                                              ▼                              │
  VISION WORKER (pixels never leave)                                         │
    undistort + resize ─▶ DM-Count (ORT-web, WebGPU | WASM) ─┐               │
    grey, low-res ─▶ optical flow ───────────────────────────┤               │
    sparse areas / roads ─▶ RT-DETR-R18 or YOLOX ────────────┤               │
    head→foot fix → homography → 2 m cells → zones, lines, queues, flags,    │
    p10/p50/p90 bands, per-cell camera fusion, health                        │
                                              ▼ ZoneObservation[] (no pixels)│
  APP: estimate layer on the map · Conditions JSON (phase 1) ◀───────────────┘
       observation tape · audit log · camera health
                                              ▼
  FORECAST: hₖ over covered cells → reweight / resample variants (phase 2)
  SERVER (SQLite): aggregates and audit log only
```

**Components:**
- `app/src/vision/`: worker, calibration UI, geometry, flow, health.
- A MediaMTX config template in `docs/`.
- Vector reweighting in `forecast.ts`.
- Server tables for aggregates and audit.
- New types live in a vision module until the engine consumes them; then `contracts.ts` follows its huddle rule.

**Models:**
- Density: DM-Count (FP16 on WebGPU, FP32 on WASM), with QNRF or SHB weights chosen per camera.
- Detection: YOLOX-S, or RT-DETR-R18 at FP16; YOLOX-Nano when compute is tight.
- Optical flow: Farneback.

All three run in a labelled demo licence mode until the density weights are retrained.

**Observation message** (proposed; one per zone per window):

```ts
export interface Band { p10: number; p50: number; p90: number }
export interface ZoneObservation {
  v: 'gameday.obs.1';
  zoneId: Id;                     // Place.id, or 'line:<id>' for a counting line
  cameraId: Id | 'fused';
  source: 'video-density' | 'video-detect' | 'edge-analytics' | 'turnstile' | 'manual' | 'synthetic';
  t0: string; t1: string;         // ISO 8601 UTC window, default 10 s
  coverage: number;               // 0..1 of the zone seen at usable resolution
  count: Band | null;             // people in the covered part; null = not measured, never a default 0
  density: Band | null;           // people per m² over the covered part
  peakCellDensity: number | null; // max over cells of at least 2 m
  flow?: { lineId: Id; inPerMin: Band; outPerMin: Band }[];
  motion?: { speedMps: number; dirDeg: number; stationaryShare: number; counterflowShare: number };
  queue?: { people: Band; waitMin: Band };
  vehicles?: { count: Band; stopped: number };
  quality: { health: 'ok' | 'degraded' | 'stale' | 'uncalibrated'; fps: number; latencyMs: number };
  provenance: { modelId: string; weightsSha256: string; calibrationId: Id; licenceMode: 'demo' | 'production' };
  flags: string[];                // e.g. 'night', 'rain', 'view-changed', 'experimental:pressure'
}
```

## Licence table

| Item | Use | Licence | Notes | Verdict |
|---|---|---|---|---|
| onnxruntime-web 1.31.1 | inference | MIT | 14.8–29.5 MB of WASM | OK; needs a decision record (heavy) |
| transformers.js / TF.js | optional / – | Apache-2.0 | – | optional / not chosen |
| OpenCV.js (@techstark 5.0.0-release.1) | optical flow | Apache-2.0 | 13.3 MB | OK |
| hls.js 1.7.3, mp4box.js 2.5.0 | ingest | Apache-2.0, BSD-3-Clause | – | OK |
| MediaMTX, go2rtc | RTSP bridge | MIT | external binary | OK |
| ByteTrack, OC-SORT | vehicle matching | MIT | – | OK, vehicles only |
| SORT; Ultralytics YOLO | – | GPL-3.0; AGPL-3.0 | – | avoid |
| DM-Count code + weights | density | MIT | SHA/SHB/QNRF data; ImageNet start | evaluation / demo only |
| CSRNet, SFANet, MobileCount | density | none stated | – | avoid |
| Bayesian Loss, M-SFANet; P2PNet | density | GPL-3.0; academic only | – | avoid |
| CLTR, STEERER, PET | density | MIT | research-data weights | evaluation only |
| YOLOX | detection | Apache-2.0 | COCO only, trained from scratch | OK; data caveat |
| RT-DETR, D-FINE, RTMDet | detection | Apache-2.0 | COCO (± Objects365); ImageNet start | OK; data caveat |
| RAFT, SEA-RAFT; NeuFlow v2 | learned flow | BSD-3; Apache-2.0 | Freiburg data, no commercial use | evaluation only |
| ShanghaiTech; UCF-QNRF | training data | BSD-2 repo, web-crawled images; none stated | – | unclear / research only |
| JHU-CROWD++; NWPU-Crowd | training data | academic, non-commercial | no commercial derivatives | research only |
| COCO; ImageNet | detector data; backbone start | CC BY 4.0 annotations (Flickr images); non-commercial | – | grey; recorded |
| Commons media; Jülich archive | testing | per-file free licences; research use with attribution | credit authors | OK |
| Pexels; Pixabay | testing | own licences | no standalone redistribution | local tests only |

## Requirements

- **VID-01** Inputs: file (MP4/H.264, WebM), webcam or UVC capture card, HLS, and WebRTC/WHEP via a local MediaMTX.
- **VID-02** All inference runs on-device in a Vision Worker (WebGPU, WASM fallback). Models are served from our origin and pinned by SHA-256; no cloud.
- **VID-03** Pixels are never persisted and never leave the worker; a test enforces the banned-API list.
- **VID-04** No face detection/recognition, re-ID, embeddings, cross-camera tracking, plate reading or demographic attributes. Such fields are dropped from edge input.
- **VID-05** Outputs are `ZoneObservation`s on cells of at least 2 m. Below 0.5 p/m², only zone totals are output.
- **VID-06** Calibration per camera: ≥4 point pairs (≥6 recommended), residual in metres, head-plane correction, valid-range mask, author and date. Images only on opt-in.
- **VID-07** The map shows camera footprints and zone coverage. Uncovered zones are `null` and drawn as inferred.
- **VID-08** Mask regions below 25 px/m; analyse at ≤125 px/m where possible.
- **VID-09** Fuse overlapping cameras per cell by inverse variance; never sum across cameras.
- **VID-10** Every value has p10/p50/p90 from per-camera validation. Uncalibrated cameras are labelled and down-weighted.
- **VID-11** DM-Count ONNX opset 17 (FP16 WebGPU, FP32 WASM). Every observation carries model, weights hash, calibration and licence mode.
- **VID-12** Research-data weights run only in a labelled demo mode. Production needs retrained or licensed weights and a decision record.
- **VID-13** Apache-2.0 detectors for sparse scenes and vehicles; no AGPL/GPL components.
- **VID-14** Density every 2–5 s per camera, flow at 2–5 Hz, 10 s windows (assumptions). Drop frames instead of queueing; report the rate achieved.
- **VID-15** Adaptive flow frame gap; convert to m/s via the homography Jacobian.
- **VID-16** Counting lines drawn on the map give directional people/min with bands, checked against gate scans.
- **VID-17** Per-gate queue polygons give length and Little's-law wait as ranges labelled "steady-state estimate".
- **VID-18** Commanders see only the "Yes" rows in §4. Pressure, turbulence and dispersal are experimental, default off, and labelled "verify on camera".
- **VID-19** Each video number is labelled "video estimate" with camera, age and range. Values older than two windows grey out. Output is never phrased as an instruction.
- **VID-20** Health checks flag frozen, dark, covered, defocused or moved views as degraded/stale. A changed view needs recalibration.
- **VID-21** MediaMTX: auth on, recording off, LAN/localhost only, H.264, no transcoding.
- **VID-22** View/calibrate/export roles. An append-only audit log covers feed views, calibration and model changes, and exports. Retention is configurable and shown.
- **VID-23** Phase 1 emits `Conditions` JSON. Phase 2 feeds `ZoneObservation`s to vector reweighting with ESS-triggered resampling and checkpoint rejuvenation.
- **VID-24** Seed + decision tape + observation tape ⇒ identical run, proven in Vitest.
- **VID-25** `startFrom` can be built from observations. Gate throughput and arrival curves can be calibrated from line flows.
- **VID-26** Before fixing the camera budget, measure WebGPU/WASM latency on the target Mac: DM-Count at 512×288, 768×432 and 1024×576, and RT-DETR-R18 at 640.
- **VID-27** Test harness: synthetic renders with exact truth, plus real clips fetched by URL + hash (never committed). Report MAE, RMSE, NAE, band coverage and CRPS per model and camera.
- **VID-28** Acceptance (assumptions to revisit): zone NAE ≤20% at ≥1 p/m²; p10–p90 covering 70–90% of truths; line flow within ±15% of turnstiles over 5 min.
- **VID-29** Edge-analytics counts (ONVIF Profile M, MQTT) enter through the same contract.
- **VID-30** Before field use: model cards, a written use policy, operator training and a 2 CFR 200.216 procurement check.

## Sources

All accessed 2026-10-26.

- **Models:**
  - Crowd counting: [DM-Count](https://github.com/cvlab-stonybrook/DM-Count) · [DM-Count paper](https://arxiv.org/abs/2009.13077) · [LWCC](https://github.com/tersekmatija/lwcc) · [LWCC weights](https://github.com/tersekmatija/lwcc_weights/releases) · [CSRNet](https://github.com/leeyeehoo/CSRNet-pytorch) · [SFANet](https://github.com/pxq0312/SFANet-crowd-counting) · [M-SFANet](https://github.com/Pongpisit-Thanasutives/Variations-of-SFANet-for-Crowd-Counting) · [Bayesian Loss](https://github.com/ZhihengCV/Bayesian-Crowd-Counting) · [P2PNet and comparison tables](https://github.com/TencentYoutuResearch/CrowdCounting-P2PNet) · [CLTR paper](https://arxiv.org/html/2202.13065v2) · [STEERER paper](https://arxiv.org/html/2308.10468v1) · [STEERER repo](https://github.com/taohan10200/STEERER) · [PET](https://github.com/cxliu0/PET) · [MobileCount](https://github.com/ChenyuGAO-CS/MobileCount) · [Chan et al. 2008](https://iacl.ece.jhu.edu/proceedings/cvpr2008/papers/229.pdf)
  - Detection: [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) · [YOLOX paper](https://arxiv.org/abs/2107.08430) · [RT-DETR](https://github.com/lyuwenyu/RT-DETR) · [RT-DETR ONNX](https://huggingface.co/onnx-community/rtdetr_r18vd) · [D-FINE](https://github.com/Peterande/D-FINE) · [RTMDet](https://github.com/open-mmlab/mmdetection/tree/main/configs/rtmdet) · [Ultralytics](https://github.com/ultralytics/ultralytics)
  - Tracking: [ByteTrack](https://github.com/ifzhang/ByteTrack) · [OC-SORT](https://github.com/noahcao/OC_SORT) · [SORT](https://github.com/abewley/sort)
  - Optical flow: [RAFT](https://github.com/princeton-vl/RAFT) · [SEA-RAFT](https://github.com/princeton-vl/SEA-RAFT) · [NeuFlow v2](https://github.com/neufieldrobotics/NeuFlow_v2)
- **Data terms:** [ShanghaiTech repo](https://github.com/desenzhou/ShanghaiTechDataset) · [MCNN paper](https://www.cv-foundation.org/openaccess/content_cvpr_2016/papers/Zhang_Single-Image_Crowd_Counting_CVPR_2016_paper.pdf) · [UCF-QNRF](https://www.crcv.ucf.edu/data/ucf-qnrf/) · [JHU-CROWD++ terms](http://www.crowd-counting.com/terms-of-use.html#terms-of-use) · [NWPU-Crowd](https://www.crowdbenchmark.com/nwpucrowd.html) · [ImageNet](https://image-net.org/download-images.php) · [COCO licensing thread](https://github.com/cocodataset/cocoapi/issues/551) · [Freiburg flow dataset terms](https://github.com/tensorflow/datasets/issues/639)
- **Browser and ingest:**
  - Inference runtimes: [ORT-web flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html) · [ORT-web WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) · [WebGPU in all major browsers (web.dev, Nov 2025)](https://web.dev/blog/webgpu-supported-major-browsers) · [transformers.js](https://github.com/huggingface/transformers.js) · [transformers.js pipelines](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/pipelines.md) · [TF.js](https://github.com/tensorflow/tfjs)
  - Frame capture and storage: [rVFC in Firefox 132](https://groups.google.com/a/mozilla.org/g/dev-platform/c/lp_5RctznkM) · [Insertable streams](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing) · [MDN Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache) · [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) · [mp4box.js](https://github.com/gpac/mp4box.js)
  - Streaming: [hls.js](https://github.com/video-dev/hls.js) · [MediaMTX](https://github.com/bluenviron/mediamtx) · [go2rtc](https://github.com/AlexxIT/go2rtc) · [RFC 9725](https://www.rfc-editor.org/info/rfc9725/) · [WHEP draft](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep)
  - Computer vision libraries: [OpenCV calib3d](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html) · [opencv-js](https://www.npmjs.com/package/@techstark/opencv-js)
- **Geometry, motion, assimilation:** [Single View Metrology](https://courses.engr.illinois.edu/cs543/sp2011/sources/criminisi00.pdf) · [Helbing et al. 2007](https://arxiv.org/abs/physics/0701203) · [Zhao et al. 2016](https://explore.ee.cuhk.edu.hk/~xgwang/papers/ZhaoLZWeccv16.pdf) · [Little 1961](https://doi.org/10.1287/opre.9.3.383) · [Ward et al. 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC4852637/) · [EnKF crowd model 2024](https://royalsocietypublishing.org/doi/10.1098/rsos.231553) · [Malleson et al. 2020](https://www.jasss.org/23/3/3.html) · [Conformal prediction](https://arxiv.org/abs/2107.07511) · [Gneiting & Raftery 2007](https://doi.org/10.1198/016214506000001437)
- **Policy and practice:**
  - US and Ohio law: [Maine](https://mainelegislature.org/legis/statutes/25/title25ch701.pdf) · [Montana SB 397](https://leg.mt.gov/content/Committees/Interim/2023-2024/Law-and-Justice/Meetings/september-2023/SB397-2023.pdf) · [Virginia 2025 report](https://rga.lis.virginia.gov/Published/2025/RD703/PDF) · [CDT 2022](https://cdt.org/insights/limiting-face-recognition-surveillance-progress-and-paths-forward/) · [OHLEG rules](https://files.ohleg.org/general/OHLEG_Rules_Regulations.pdf) · [Ohio AG task force](https://www.ohioattorneygeneral.gov/Files/Briefing-Room/News-Releases/AG-Facial-Recognition-Task-Force-Report-FINAL) · [Ohio R.C. 149.43](https://codes.ohio.gov/ohio-revised-code/section-149.43) · [2 CFR 200.216](https://www.law.cornell.edu/cfr/text/2/200.216)
  - Frameworks and codes of practice: [IACP framework](https://www.theiacp.org/sites/default/files/all/i-j/IACP%20Technology%20Policy%20Framework%20January%202014%20Final.pdf) · [EU AI Act](https://eur-lex.europa.eu/eli/reg/2024/1689/oj) · [FPF on Art. 5](https://fpf.org/blog/red-lines-under-the-eu-ai-act-understanding-prohibited-ai-practices-and-their-interplay-with-the-gdpr-dsa/) · [UK camera code](https://www.gov.uk/government/publications/update-to-surveillance-camera-code/amended-surveillance-camera-code-of-practice-accessible-version) · [NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework)
  - Standards and industry: [IEC 62676-4 via Axis](https://whitepapers.axis.com/download/wp_pixel_density_based_on_iec_62676_4_2014_t10176489_2604.pdf) · [AXIS Object Analytics](https://www.axis.com/for-developers/axis-object-analytics-counting-data) · [ONVIF Profile M](https://www.onvif.org/profiles/profile-m/) · [Profile M PDF](https://www.onvif.org/wp-content/uploads/2022/05/onvif-profile-m.pdf) · [ISA-18](https://isa.org/standards-and-publications/isa-standards/isa-18-series-of-standards)
  - Stadium safety: [Green Guide](https://sgsa.org.uk/green-guide/) · [SGSA control points](https://sgsa.org.uk/document/control-points/)
- **Test media:** [Commons licensing](https://commons.wikimedia.org/wiki/Commons:Licensing) · [Ohio Stadium photo](https://commons.wikimedia.org/wiki/File:Ohio_Stadium_during_OSU_vs_Purdue_11-13-21.jpg) · [London Stadium photo](https://commons.wikimedia.org/wiki/File:London_Stadium_crowd_control.jpg) · [Moussaïd et al. video](https://commons.wikimedia.org/wiki/File:Traffic-Instabilities-in-Self-Organized-Pedestrian-Crowds-pcbi.1002442.s004.ogv) · [Jülich archive](https://ped.fz-juelich.de/da/doku.php) · [Pexels rules](https://help.pexels.com/hc/en-us/articles/360042332714-What-are-the-rules-for-using-Pexels-photos-or-videos) · [Pixabay licence](https://pixabay.com/service/license-summary/)

Content was rephrased for compliance with licensing restrictions.

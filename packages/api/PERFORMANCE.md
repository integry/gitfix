# API latency diagnostics

`PROPR_API_TIMING_SAMPLE_RATE` enables privacy-safe request attribution for a
fraction of API requests. It accepts a value from `0` to `1` and defaults to
`0` (disabled). A short diagnostic window can use `0.01`; use `1` only for a
bounded, low-traffic investigation.

Each `[api-performance]` record contains the static Express route template,
status, total time, shared middleware time, an event-loop scheduling probe and
aggregate stage durations. Relevant stages distinguish authentication,
authorization, bearer-cache access, GitHub fallback, session grant sync,
agent-health work, queue work and named SQL operations. Records never include
the request URL or query string, headers, credentials, bodies, SQL, or SQL
parameters. At most 24 stage names are retained per request.

## Issue #2355 measurements

The production baseline supplied with the issue is 18 sequential authenticated
GETs over three rounds. Its medians were 2,578–3,769 ms, including 2,584 ms for
the 11-byte generating-plan response; a same-credential loopback read was
2,085 ms. These values are the deployment baseline, not reproduced locally.

The focused regression fixtures record these before/after work counts:

| Fixture | Before | After |
| --- | ---: | ---: |
| 12 simultaneous expired-cache status reads, one configured agent | 12 health probes | 1 health probe |
| Task-list count presentation enrichments | 3 full-history enrichments | 0 enrichments |

The status result retains the existing five-second freshness window; concurrent
misses now share one in-flight snapshot, and the window begins when that
snapshot completes. The task page still performs its processing/completion and
critique enrichments; only the logically independent count avoids repeating
them. These are labeled fixtures and are not claims about production latency.
A deployment comparison should repeat the issue's exact credential, endpoints,
parameters, ordering and three-round method, with a temporary bounded timing
sample enabled to attribute any remaining delay.

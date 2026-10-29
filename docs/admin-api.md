# Chamabondo admin API

The admin API uses the existing bearer JWT authentication. Roles are `teacher`,
`teacher_in_charge`, `deputy_head`, and `head`. A teacher-in-charge (TIC) is
restricted to the department on their current user record; a supplied
`department` query parameter cannot widen that scope. Foreign staff profiles
return 404 and foreign record writes return 403. Head/deputy-head scope is
school-wide.

## Setup

Install the added packages via `npm install`. The server now uses `helmet`,
`pdfkit`, and `web-push`. Add the following to `.env` to enable web push:

```env
VAPID_PUBLIC_KEY=<public-key>
VAPID_PRIVATE_KEY=<private-key>
VAPID_SUBJECT=mailto:admin@your-school.example
```

Generate a key pair using:

```powershell
npx web-push generate-vapid-keys
```

VAPID values are optional; in-app notifications continue to work without them.
Never commit a real private key.

Bulk reviews and head-account changes use MongoDB transactions to preserve the
all-or-nothing guarantee and the active-head invariant. Configure MongoDB as a
replica set (including local development) before using those endpoints.

Attendance rate uses the current Zimbabwe school-year term windows: Jan-Apr,
May-Aug, and Sep-Dec. Holidays, leave, and sick leave are excluded from the
attendance-rate denominator.

## Admin endpoints

All `/api/admin` endpoints require `teacher_in_charge`, `deputy_head`, or
`head`; admin requests are rate limited.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/overview` | Staff count, today's status counts and absences, pending review counts, upcoming items, recent updates |
| GET | `/api/admin/staff?search=&department=&active=&sort=` | Staff with term attendance rate and KRA/scheme-book totals |
| GET | `/api/admin/staff/:id` | Scoped staff profile and records |
| GET | `/api/admin/attendance/day?date=YYYY-MM-DD&department=` | Status for each active teacher in scope |
| PATCH | `/api/admin/attendance/:id` | Correct status; requires `{ "status": "Present", "reason": "..." }` |
| POST | `/api/admin/kras/bulk-review` | `{ "ids": ["..."], "status": "approved", "comment": "..." }` |
| POST | `/api/admin/schemebooks/bulk-review` | `{ "ids": ["..."], "status": "Approved", "comment": "..." }` |
| GET | `/api/admin/reports/:type?from=&to=&department=&format=` | Types: `attendance-monthly`, `kra-status`, `schemebook-submission`, `staff-summary`; format `json`, `csv`, or `pdf` |
| POST | `/api/admin/comms` | Create and immediately publish or schedule a communication |
| GET | `/api/admin/comms/sent` | Sender's communications with read counts |
| PUT/DELETE | `/api/admin/comms/:id` | Creator, deputy head, or head only |
| GET | `/api/admin/comms/:id/rsvps` | Sender-only RSVP results |
| PATCH | `/api/admin/users/:id/role` | Head only; body `{ "role": "teacher_in_charge" }` |
| PATCH | `/api/admin/users/:id/department` | Head only; body `{ "department": "ECD" }` |
| PATCH | `/api/admin/users/:id/status` | Head only; body `{ "active": false }` |
| GET | `/api/admin/audit?from=&to=&action=&actorId=` | Head-only audit history |

Review status must be Approved/Rejected. Rejection requires a comment. A
communication accepts `type`, `title`, `description`, `audience` (`all` or
`department`), optional `department`, `recipientIds`, `attachment`,
`scheduledAt`, `rsvpEnabled`, `priority`, `pinned`, and `expiresAt`. A TIC is
always locked to their own department; only a head/deputy may pin.

## Teacher communications, notifications, and push

* `POST /api/comms/:id/seen`
* `POST /api/comms/:id/rsvp` with `{ "response": "accepted" }`
* `GET /api/notifications`
* `PATCH /api/notifications/:id/read`
* `PATCH /api/notifications/read-all`
* `POST /api/push/subscribe` with the browser `PushSubscription` JSON
* `DELETE /api/push/subscribe` with `{ "endpoint": "https://..." }`

Push subscription endpoints are restricted to common browser push services.
Expired subscriptions (HTTP 404/410) are deleted automatically.

## Example requests

Set `TOKEN` and IDs using the active environment:

```powershell
$headers = @{ Authorization = "Bearer $env:TOKEN"; "Content-Type" = "application/json" }
Invoke-RestMethod "http://localhost:5000/api/admin/overview" -Headers $headers

Invoke-RestMethod "http://localhost:5000/api/admin/staff?search=Grace&sort=-attendanceRate" -Headers $headers

$body = @{ status = "Present"; reason = "Verified against the signed register" } | ConvertTo-Json
Invoke-RestMethod -Method Patch "http://localhost:5000/api/admin/attendance/$env:ATTENDANCE_ID" -Headers $headers -Body $body

$review = @{ ids = @($env:KRA_ID); status = "approved"; comment = "Reviewed" } | ConvertTo-Json
Invoke-RestMethod -Method Post "http://localhost:5000/api/admin/kras/bulk-review" -Headers $headers -Body $review

$comms = @{
  type = "Meeting"
  title = "Term planning meeting"
  description = "Bring the term plans."
  audience = "department"
  department = "ECD"
  scheduledAt = "2026-11-02T08:00:00+02:00"
  rsvpEnabled = $true
  priority = "Important"
} | ConvertTo-Json
Invoke-RestMethod -Method Post "http://localhost:5000/api/admin/comms" -Headers $headers -Body $comms

Invoke-WebRequest "http://localhost:5000/api/admin/reports/staff-summary?format=pdf" -Headers $headers -OutFile report.pdf
```

## TIC scope verification

Import [`../tests/admin-scope.postman_collection.json`](../tests/admin-scope.postman_collection.json)
in Postman, set `ticToken` to a teacher-in-charge token for ECD and set the
foreign record IDs. The collection asserts 403 for a cross-department query
and attendance edit, 404 for a foreign profile, and that every listed staff
member belongs to ECD.

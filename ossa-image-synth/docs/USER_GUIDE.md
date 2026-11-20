# Image Synth: user guide

## 1. Sign in and choose a project
Open the address your administrator gave you and sign in. Use **Projects** in the left sidebar to choose a
project, or **+ New** to create one. Each project's documents, facts, images and lessons are fully separate.
Nothing moves between projects.

The **reference project** (Myers Park Country Club — Halfway House) contains OSSA's initial finish references
(P1–P4, PL2, SS1, SS2, WCP1) and project lessons. The finish records are marked *reference* and *proposed*.
Confirm them against the uploaded finish schedule before approving.

## 2. Read the canvas
Each node is a module. Its colour shows its state:

| Colour | State | Meaning |
|---|---|---|
| grey | EMPTY | nothing provided yet |
| blue | PROCESSING | documents are being extracted |
| amber | NEEDS REVIEW | information exists but is not yet validated, or something is missing |
| green | VALIDATED | every required item is approved |
| red | ERROR | extraction or the provider failed, or a source file's hash does not match |

Cables carry the colour of their upstream module, so an amber cable means "this input is not yet trusted".
Solid cables are dependencies that the readiness rules enforce. You can drag from a node's right port to
another node's left port to add your own dashed **manual cables** as annotations. Select one and press
Delete to remove it. Drag nodes to move them, select a node to resize it, and use ▾ to collapse it. The
layout is saved per project. **Auto-connect / reset layout** restores the default layout and cables.

The **Readiness** bar at the top lists every module and shows whether image execution is ready or blocked.
Click a chip to open that module.

## 3. Upload documents (Node 09)
Drop drawings, specifications, schedules and renders into Document Intake. For each file you see:
- its classification, the evidence behind it and a confidence value. If it is wrong, change the dropdown;
  you will be asked for a reason, which goes into the QA log.
- the proposed module mapping. **Accept** or **Reject** it. Uploading alone never satisfies a module.
- warnings, for example a scanned PDF with no text layer. OCR is not available, so enter that data manually.

DWG and RVT files are stored but not read. Export sheets to PDF and schedules to CSV/XLSX.

## 4. Review the extracted information (Nodes 01, 02, 03)
Every record shows where it came from (file, row, line or page) and the text it was read from.
- **Approve** records that are correct, **Reject** wrong ones, and use **Correct** to fix values. Corrections
  are logged with before/after values.
- **+ Add manually** records information that is missing from the documents.
- Node 02 flags conflicting records for the same code, such as a reference record that differs from the
  schedule. Reject the wrong one.
- In Node 03, an equipment schedule alone never validates locations. Upload and accept the equipment plan, then
  approve the "found on plan" evidence for each item or **Mark location verified** after checking it yourself.

## 5. Authorise the source image and draw masks (Node 05)
- **Authorise as source** for the render you will edit. **Verify hash** proves the stored file is the original.
- **Draw mask**: choose *Edit region* (what the AI may change) or *Protected region* (what must not change, even
  inside the edit region). Use Rectangle, Brush or Eraser, then **Save mask** and **Approve** it.
- *AI analysis* (optional) stores an advisory description as an **AI assumption**. It never satisfies a
  finish or equipment requirement.

## 6. Describe the change (Node 04)
Select the authorised image, describe the change, and reference finish codes, for example
*"Change the lower cabinet faces to PL2. Keep the SS2 backsplash and black separators unchanged."*
Choose the edit mask, and optionally a protected mask. Keep **compositing** on so the original pixels outside
the mask are retained. Click **Analyse intent**. Blocking issues must be fixed before you can **Approve**:
- unknown or unapproved finish codes
- geometry or camera changes (re-render those in Enscape)
- object additions not explicitly allowed
- a missing mask
- an unauthorised global edit

## 7. Run it (Node 07)
Choose **AUTO BEST** (the highest-ranked compatible model in OSSA's evaluation registry) or **MANUAL**. Click
**Check readiness & select model** to see:
- any blocking modules
- the selected model and the reason for the choice
- every candidate, with why it is or is not usable
- the estimated cost against the project budget

If a manually selected model cannot do the job, the reason is shown. Image Synth never switches models on
its own; you can approve a suggested alternative. Click **Run image edit** and confirm the cost. Progress is
shown in the Jobs table. If the provider fails, the job shows the error and no output is created.

## 8. Review and decide (Node 08)
Compare the original and the output with the before/after slider, side-by-side, overlay, difference and mask
views. The automated checks are measurements. For example, "VERIFIED pixel-identical outside the edit region:
0 of 1,183,200 pixels changed" is only shown when it has been measured.

Tick each item of the finish compliance checklist after inspecting it, then:
- **Approve**: blocked while any required check fails or the checklist is incomplete. An owner or reviewer
  can approve anyway by giving an override reason, which is recorded.
- **Reject**: give a reason and a QA category, and optionally save it as a project lesson.
- **Request revision**: creates a new draft edit request with your revised instruction.

**Download PNG** saves the output. **Export** (top bar) downloads a ZIP containing the decision history and
approved images. Exports never include credentials.

## 9. Learn (Node 06)
The QA log is a record you can review. Active lessons are added to every prompt for the project. Model
rankings change only according to recorded approvals, rejections and failures.

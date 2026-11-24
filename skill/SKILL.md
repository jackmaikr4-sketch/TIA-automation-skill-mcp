---
name: tia-automation
description: Use tia-mcp with TIA Portal V18 and PLCSIM Advanced to edit PLC programs, compile, archive and verify local simulation. Use for LAD/SCL and supported S7-1500 workflows.
---

# TIA workflow

1. Run tia_diagnose and tia_capabilities before assuming the local installation supports a task. Inspect running sessions; attach only to the requested PID or create a new owned session.
2. Read the actual project, CPU, blocks and tags. An attached project requires explicit scope authorization. Do not save over pre-existing unsaved changes or close a user-owned session.
3. Use an exact installed hardware catalog identifier; never invent CPU order numbers or firmware versions. Work within configured allowedRoots.
4. Archive before modifications. Read source/XML and use required hash guards when editing. For LAD, preserve the project's real XML structure; do not infer functionality from a screenshot alone.
5. Compile hardware and software. Inspect errors and nested messages; use tia_compile_save only when compilation is successful. Retain backup and failure reports.
6. Prefer local PLCSIM Advanced and the configured Softbus workflow. Operate only the simulation instances owned or explicitly selected by this task. Never terminate unrelated simulators.
7. Verify simulation using real tag values and state transitions for the requested start/stop/jog conditions. Report the actual compiler and simulation results, including unresolved limitations.
8. Physical PLC access is a separate, explicitly authorized workflow; never treat simulation permission as permission to download to production hardware. Respect physical-target approval and identity checks.
9. Keep the MCP connection alive while its simulation or panel is in use. Save and close only owned, explicitly requested projects. Deliver source, archive, compile report and observed test results.

Supported baseline: Windows, TIA Portal V18, one S7-1500 CPU and compatible PLCSIM Advanced. HMI, S7-1200 standard PLCSIM and multi-PLC orchestration are not claimed as fully supported.

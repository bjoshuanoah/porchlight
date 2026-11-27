// The console tab model — the console surfaces (PORCH-135, extended by
// PORCH-130 with the live/timeline/status planes), following the PORCH-057
// console tab pattern from apps/web: the tab list is pure data, the screen
// consumes it, and short labels keep the bar usable on a narrow viewport
// where the tabs move to the bottom.

export const consoleTabs = [
  { id: "live", label: "Live" },
  { id: "timeline", label: "Timeline" },
  { id: "camera", label: "Cameras" },
  { id: "composition", label: "Composition" },
  { id: "speed", label: "Speed" },
  { id: "profiles", label: "Profiles" },
  { id: "storage", label: "Storage" },
  { id: "compute", label: "Compute" },
  { id: "transcripts", label: "Transcripts" },
  { id: "status", label: "Status" },
];

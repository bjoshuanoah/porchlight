// Composition inspector (PORCH-135 ac-2): shows the effective zone and mask
// definitions for a camera, each labeled with its contributor, plus the
// overlap groups. Overlapping definitions compose as a union — the copy
// says so plainly and never uses "wins"/override language, because the
// resolver never resolves overlap as a silent override.
import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

const KIND_LABEL = { zone: "Zone", mask: "Mask", "zone+mask": "Zone ∩ mask" };
const KIND_COLOR = { zone: "#2E7D32", mask: "#C62828" };

export default function CompositionInspector({ camera, api }) {
  const [composition, setComposition] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!camera) {
      setComposition(null);
      return undefined;
    }
    let cancelled = false;
    api
      .getComposition(camera.id)
      .then((payload) => {
        if (!cancelled) {
          setComposition(payload);
          setError("");
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, camera?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- camera id is the trigger

  if (!camera) {
    return <Typography color="text.secondary">Select a camera to inspect its composition.</Typography>;
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body1">
        Overlapping zone and mask definitions compose as a union: a point is covered when any enabled zone covers it,
        and excluded when any enabled mask excludes it. No definition silently overrides another — every contributor
        stays listed.
      </Typography>

      {error && <Typography color="error">{error}</Typography>}

      <Stack direction="row" spacing={2} sx={{ flexWrap: "wrap", alignItems: "flex-start" }}>
        <DefinitionColumn
          title="Zones (union of enabled coverage)"
          rows={composition?.zones}
          kind="zone"
        />
        <DefinitionColumn
          title="Masks (union of exclusions)"
          rows={composition?.masks}
          kind="mask"
        />
      </Stack>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2">Overlap groups</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Enabled definitions whose polygons intersect — within a kind they
          compose into one effective region, and across kinds the zone and mask
          both stay listed with their contributions intact.
        </Typography>
        {(composition?.overlaps ?? []).length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No overlapping definitions on this camera.
          </Typography>
        ) : (
          <List dense disablePadding>
            {composition.overlaps.map((group, index) => (
              <ListItem key={group.ids.join("|") || index} disableGutters>
                <ListItemText
                  primary={`${KIND_LABEL[group.kind]} overlap: ${group.ids.join(" + ")}`}
                  secondary="Every contributor stays listed — the intersection resolves visibly, never silently."
                />
              </ListItem>
            ))}
          </List>
        )}
      </Paper>
    </Stack>
  );
}

function DefinitionColumn({ title, rows, kind }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 300, flex: 1 }}>
      <Typography variant="subtitle2" sx={{ color: KIND_COLOR[kind] }}>
        {title}
      </Typography>
      <Divider sx={{ my: 1 }} />
      {rows === undefined ? (
        <Typography variant="body2" color="text.secondary">
          Loading…
        </Typography>
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          None defined.
        </Typography>
      ) : (
        <List dense disablePadding>
          {rows.map((row) => (
            <ListItem key={row.id} disableGutters>
              <ListItemText
                primary={
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Chip size="small" variant="outlined" label={row.id} sx={{ color: KIND_COLOR[kind] }} />
                    {row.name || "(unnamed)"}
                  </Box>
                }
                secondary={row.enabled ? "Enabled — contributes to the composed set" : "Disabled — listed, not composed"}
              />
            </ListItem>
          ))}
        </List>
      )}
    </Paper>
  );
}

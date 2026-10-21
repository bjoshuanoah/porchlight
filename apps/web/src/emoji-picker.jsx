// The reaction picker (PORCH-036): a visual, categorized emoji surface with
// search — never a typed, pasted, or otherwise character-entered emoji
// string. Bespoke by documented ruling: MUI lacks any emoji-picker
// primitive, so this composes MUI primitives only (Popover, Tabs, TextField,
// IconButton) under the Porchlight tokens. Open vocabulary: the picker
// offers every Unicode emoji and never restricts which one a member reacts
// with; no counts and no hub-defined emoji set render here.
//
// PORCH-120 (Brian, Oct 21 2026): the Frequently Used tab anchors the tab
// row, ahead of the Unicode category tabs — the member's account-level
// most-used emoji, most-first (the usage read rides the shared EmojiPicker,
// so every opener surface inherits it). Order is the only expression of
// frequency: no count, tally, or quantity renders beside any emoji. With no
// usage history the tab renders its family-copy empty state, never a fake
// or seeded list. And the keyboard never covers the results: on mobile
// widths a risen keyboard re-anchors the picker INSIDE the visual viewport
// (emoji-viewport.js) so the focused field and every selectable emoji stay
// visible; dismissing the keyboard restores the resting anchor cleanly, on
// the same DOM (an in-progress pick never scrolls out from under the
// finger). Desktop keeps the anchored popover exactly as shipped.
import React, { useEffect, useMemo, useState } from 'react';
import { Box, IconButton, Popover, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { cssVars } from './theme.js';
import { EMOJI_CATEGORIES, emojiRowOf, searchEmojis } from './emoji-data.js';
import { keyboardDock } from './emoji-viewport.js';

/** The Frequently Used tab leads the tab row — first position (build call
 *  recorded on the task trail). */
export const FREQUENT_SLUG = 'frequently-used';
export const FREQUENT_LABEL = 'Frequently Used';
/** The cold state (no usage history yet): family copy, no fake list. */
export const FREQUENT_EMPTY_STATE = 'React a few times and your favorites will appear here.';

const FREQUENT_TAB = { slug: FREQUENT_SLUG, label: FREQUENT_LABEL };
const RESTING_GRID_MAX = 272;

/**
 * While the picker is open, follow the visual viewport so a risen keyboard
 * moves the picker inside it (`emoji-viewport.js` geometry) and a closed
 * keyboard restores the resting anchor. Null whenever the keyboard is not
 * risen or the width is desktop-class — the resting behavior.
 */
function useKeyboardDock(open) {
  const [dock, setDock] = useState(null);
  useEffect(() => {
    if (!open) { setDock(null); return undefined; }
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const measure = () => setDock(keyboardDock({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewport: viewport,
    }));
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      setDock(null);
    };
  }, [open]);
  return dock;
}

export default function EmojiPicker({ anchorEl, open, onClose, own = new Set(), onToggle, busy, frequent = [] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(0);
  useEffect(() => {
    if (open) { setQuery(''); setCategory(0); }
  }, [open]);
  const dock = useKeyboardDock(open);
  const results = useMemo(() => (
    query.trim() ? searchEmojis(query) : category === 0
      ? frequent.map((emoji) => emojiRowOf(emoji))
      : EMOJI_CATEGORIES[category - 1]?.emojis ?? []
  ), [query, category, frequent]);
  const searching = Boolean(query.trim());
  // Docked geometry: the paper rides the visual viewport; the grid keeps
  // the field and results inside it (the resting grid cap otherwise).
  const gridMax = dock ? Math.max(120, Math.round(dock.height) - 96) : RESTING_GRID_MAX;
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorReference={dock ? 'anchorPosition' : 'anchorEl'}
      anchorPosition={dock ? { top: dock.top, left: dock.left } : undefined}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={dock
        ? { vertical: 'top', horizontal: 'left' }
        : { vertical: 'bottom', horizontal: 'left' }}
      slotProps={{
        paper: {
          elevation: 0,
          sx: {
            width: 356,
            // Docked: the paper lives INSIDE the visual viewport (the risen
            // keyboard occupies from keyboardTop down — nothing pickable
            // sits beneath); resting: the shipped anchored popover.
            ...(dock ? {
              maxWidth: Math.round(dock.width),
              maxHeight: Math.round(dock.height),
              overflow: 'hidden',
            } : { maxWidth: '92vw' }),
            p: 2,
            borderRadius: '18px',
            border: `1px solid ${cssVars.border}`,
            boxShadow: cssVars.shadowModal,
          },
        },
      }}
    >
      <PickerBody
        query={query}
        onQuery={setQuery}
        category={category}
        onCategory={setCategory}
        results={results}
        searching={searching}
        own={own}
        onToggle={onToggle}
        busy={busy}
        frequent={frequent}
        gridMax={gridMax}
      />
    </Popover>
  );
}

/**
 * The picker body — one code path for every opener surface (post rows,
 * comment rows, card and detail alike, PORCH-038 + PORCH-101). The body
 * owns search, tabs, grid, and empty states; the Frequently Used tab rides
 * the same grid treatment as every category tab.
 */
export function PickerBody({
  query,
  onQuery,
  category,
  onCategory,
  results = [],
  searching = false,
  own = new Set(),
  onToggle,
  busy,
  frequent = [],
  gridMax = RESTING_GRID_MAX,
}) {
  const ownRow = (emoji) => own?.has(emoji);
  const pick = (emoji) => { if (!busy) onToggle?.(emoji, ownRow(emoji)); };
  const tabs = useMemo(() => [FREQUENT_TAB, ...EMOJI_CATEGORIES], []);
  const gridEmpty = searching
    ? <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>No emoji matched that search.</Typography>
    : category === 0 && frequent.length === 0
      // Cold state (PORCH-120): the member's usage has no history yet — the
      // honest family copy, never a fake or seeded list.
      ? <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{FREQUENT_EMPTY_STATE}</Typography>
      : null;
  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label="Search emoji"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        inputProps={{ 'aria-label': 'Search emoji' }}
        placeholder="heart, sun, laugh…"
      />
      {!searching && (
        <Tabs value={category} onChange={(event, next) => onCategory(next)} variant="scrollable" scrollButtons={false} allowScrollButtonsMobile sx={{ minHeight: 36 }}>
          {tabs.map((group) => (
            <Tab key={group.slug} label={shortLabel(group.label)}
              sx={{ minHeight: 36, py: 0.5, px: 1.5, fontSize: 12, fontWeight: 600 }}
              aria-label={`${group.label} emoji category`} />
          ))}
        </Tabs>
      )}
      <Box role="listbox" aria-label={searching ? 'Emoji search results' : 'Emoji picker grid'}
        sx={{
          overflowY: 'auto',
          maxHeight: gridMax,
          // The keyboard-rise restore (PORCH-120) rides the standard motion
          // token — the grid's measure change eases, the pick never jumps.
          transition: (theme) => theme.transitions.create('max-height', { duration: theme.transitions.duration.standard }),
        }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 44px)', justifyContent: 'center', gap: 0.25 }}>
          {results.map((row) => {
            const ownEmoji = ownRow(row.emoji);
            return (
              <IconButton
                key={row.slug || row.emoji}
                onClick={() => pick(row.emoji)}
                aria-pressed={Boolean(ownEmoji)}
                aria-label={`${row.name}${ownEmoji ? ' — tap to remove your reaction' : ''}`}
                disabled={busy}
                sx={{
                  width: 44,
                  height: 44,
                  fontSize: 22,
                  borderRadius: '10px',
                  backgroundColor: ownEmoji ? cssVars.amberSoft : 'transparent',
                  border: `1px solid ${ownEmoji ? cssVars.amber : 'transparent'}`,
                  '&:hover': { backgroundColor: ownEmoji ? cssVars.amberSoft : cssVars.subtle },
                }}
              >
                {row.emoji}
              </IconButton>
            );
          })}
        </Box>
        {gridEmpty}
      </Box>
    </Stack>
  );
}

const shortLabel = (label) => label.split(' & ')[0];
// The reaction picker (PORCH-036): a visual, categorized emoji surface with
// search — never a typed, pasted, or otherwise character-entered emoji
// string. Bespoke by documented ruling: MUI lacks any emoji-picker
// primitive, so this composes MUI primitives only (Popover, Tabs, TextField,
// IconButton) under the Porchlight tokens. Open vocabulary: the picker
// offers every Unicode emoji and never restricts which one a member reacts
// with; no counts and no hub-defined emoji set render here.
import React, { useEffect, useMemo, useState } from 'react';
import { Box, IconButton, Popover, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { cssVars } from './theme.js';
import { EMOJI_CATEGORIES, searchEmojis } from './emoji-data.js';

export default function EmojiPicker({ anchorEl, open, onClose, own = new Set(), onToggle, busy }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(0);
  useEffect(() => {
    if (open) { setQuery(''); setCategory(0); }
  }, [open]);
  const results = useMemo(() => (
    query.trim() ? searchEmojis(query) : EMOJI_CATEGORIES[category]?.emojis ?? []
  ), [query, category]);
  const ownRow = (emoji) => own?.has(emoji);
  const pick = (emoji) => { if (!busy) onToggle?.(emoji, ownRow(emoji)); };
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{
        paper: {
          elevation: 0,
          sx: {
            width: 356,
            maxWidth: '92vw',
            p: 2,
            borderRadius: '18px',
            border: `1px solid ${cssVars.border}`,
            boxShadow: cssVars.shadowModal,
          },
        },
      }}
    >
      <Stack spacing={1.5}>
        <TextField
          size="small"
          label="Search emoji"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          inputProps={{ 'aria-label': 'Search emoji' }}
          placeholder="heart, sun, laugh…"
        />
        {!query.trim() && (
          <Tabs value={category} onChange={(event, next) => setCategory(next)} variant="scrollable" scrollButtons={false} allowScrollButtonsMobile sx={{ minHeight: 36 }}>
            {EMOJI_CATEGORIES.map((group) => (
              <Tab key={group.slug} label={shortLabel(group.label)} sx={{ minHeight: 36, py: 0.5, px: 1.5, fontSize: 12, fontWeight: 600 }} aria-label={`${group.label} emoji category`} />
            ))}
          </Tabs>
        )}
        <Box role="listbox" aria-label={query.trim() ? 'Emoji search results' : 'Emoji picker grid'} sx={{ overflowY: 'auto', maxHeight: 272 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 44px)', justifyContent: 'center', gap: 0.25 }}>
            {results.map((row) => {
              const ownEmoji = ownRow(row.emoji);
              return (
                <IconButton
                  key={row.slug}
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
          {!results.length && <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>No emoji matched that search.</Typography>}
        </Box>
      </Stack>
    </Popover>
  );
}

const shortLabel = (label) => label.split(' & ')[0];
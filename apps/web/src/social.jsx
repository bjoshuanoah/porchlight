import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, InputLabel, MenuItem, Select,
  Stack, TextField, Typography,
} from '@mui/material';

const rows = (value) => Array.isArray(value) ? value : Array.isArray(value?.posts) ? value.posts : [];
const identityOf = (row) => String(row?._id ?? row?.id ?? '');
const originOf = (post) => post?.originNetworkId ?? post?.networkId ?? post?.origin?.id;
const networkId = (data) => data?.network?._id ?? data?.network?.id;
const originName = (post, data) => post?.origin?.name ?? post?.network ?? (String(originOf(post)) === String(networkId(data)) || !originOf(post) ? data?.network?.name : null) ?? originOf(post) ?? 'This network';
const visibleAtOrigin = (post, data) => !originOf(post) || !networkId(data) || String(originOf(post)) === String(networkId(data)) || data.connections?.some((connection) => String(connection.networkId) === String(originOf(post)) || (post.origin && String(connection.url).replace(/\/$/, '') === String(post.origin).replace(/\/$/, '')));
const groupAtOrigin = (group, data) => !group?.networkId || !networkId(data) || String(group.networkId) === String(networkId(data));
const postKey = (post) => `${post?.origin ?? originOf(post) ?? ''}:${identityOf(post)}`;
const mentionsOf = (value) => [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
const atCurrentOrigin = (post, data) => post.origin ? post : { ...post, origin: data.server?.url, network: data.network?.name };
const memberName = (id, data) => id && id === data.identity?.id ? data.identity.name || 'You' : 'A family member';
const messageOf = (error) => error?.message || 'That did not work. Please try again.';
const dateOf = (value) => {
  if (!value || Number.isNaN(new Date(value).valueOf())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
};

function invoke(actions, key, ...args) {
  if (typeof actions?.[key] !== 'function') throw new Error('This action is not available here yet.');
  return actions[key](...args);
}

function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(callback, onSuccess) {
    setError('');
    setBusy(true);
    try {
      if (typeof callback !== 'function') throw new Error('This action is not available here yet.');
      const result = await callback();
      await onSuccess?.(result);
      return result;
    } catch (failure) {
      setError(messageOf(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function MediaItem({ id, post, actions }) {
  const [resource, setResource] = useState(null);
  const [loadError, setLoadError] = useState('');
  const operation = useOperation();
  const getMedia = actions?.getMedia;
  const origin = post?.origin ?? originOf(post);
  useEffect(() => {
    let active = true;
    let url;
    setResource(null);
    setLoadError('');
    // Browsing renditions are not decodable in the current hub. Retrieve the original.
    Promise.resolve().then(() => {
      if (typeof getMedia !== 'function') throw new Error('Media is not available here yet.');
      return getMedia(id, 'original', origin);
    }).then((blob) => {
      if (!(blob instanceof Blob)) throw new Error('Your hub did not return the media.');
      if (active) {
        url = URL.createObjectURL(blob);
        setResource({ blob, url });
      }
    }).catch((error) => { if (active) setLoadError(messageOf(error)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [id, getMedia, origin]);
  return <Box>
    {resource && post.type === 'photo' && <Box component="img" src={resource.url} alt={post.caption || 'Shared photo'} loading="lazy" sx={{ display: 'block', width: '100%', maxHeight: 440, objectFit: 'contain', borderRadius: 2, bgcolor: 'background.default' }} />}
    {resource && post.type === 'video' && <Box component="video" src={resource.url} controls preload="metadata" sx={{ display: 'block', width: '100%', maxHeight: 440 }} />}
    {resource && post.type === 'audio' && <Box component="audio" src={resource.url} controls preload="none" sx={{ width: '100%' }} />}
    {!resource && !loadError && <CircularProgress size={20} aria-label="Loading media" />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    <Button size="small" disabled={operation.busy} onClick={() => operation.run(async () => {
      const blob = resource?.blob ?? await invoke(actions, 'getMedia', id, 'original', origin);
      if (!(blob instanceof Blob)) throw new Error('Your hub did not return the original.');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${id}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}>Get original</Button>
    {operation.error && <Alert severity="error">{operation.error}</Alert>}
  </Box>;
}

function Media({ post, actions }) {
  const media = Array.isArray(post?.mediaRefs) ? post.mediaRefs : [];
  if (!media.length) return null;
  return <Stack spacing={1} sx={{ mt: 2 }}>
    {media.map((entry, index) => {
      const id = typeof entry === 'string' ? entry : entry?.mediaId ?? entry?._id ?? entry?.id;
      return id ? <MediaItem key={`${id}-${index}`} id={id} post={post} actions={actions} /> : null;
    })}
  </Stack>;
}

function PresentReactions({ post, actions }) {
  const [emojis, setEmojis] = useState(null);
  useEffect(() => {
    let current = true;
    setEmojis(null);
    Promise.resolve().then(() => invoke(actions, 'loadReactions', post))
      .then((values) => { if (current && Array.isArray(values)) setEmojis(values); })
      .catch(() => { if (current) setEmojis([]); });
    return () => { current = false; };
  }, [identityOf(post), actions.loadReactions]);
  // Only the emoji actually present render. No counts, no who-reacted view.
  if (!emojis || !emojis.length) return null;
  return <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2 }} aria-label="Reactions from your family">
    {emojis.map((emoji) => <Chip key={emoji} label={emoji} size="small" sx={{ minHeight: 40, minWidth: 40, fontSize: 20 }} />)}
  </Stack>;
}

function PostCard({ post, data, actions, navigate, detail = false, onHide }) {
  const [localHidden, setLocalHidden] = useState(false);
  const [emoji, setEmoji] = useState('');
  const operation = useOperation();
  if (localHidden || actions?.isHidden?.(post) || !visibleAtOrigin(post, data)) return null;
  const openPost = () => navigate?.(`/posts/${encodeURIComponent(identityOf(post))}`);
  return <Card variant="outlined" sx={{ borderRadius: 3 }}>
    <CardContent>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <Box>
          <Typography variant="subtitle1" fontWeight={700}>{post.author?.name ?? post.authorName ?? memberName(post.authorId, data)}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Chip label={`From ${originName(post, data)}`} size="small" color="primary" variant="outlined" />
            {post.groupName && <Chip label={post.groupName} size="small" variant="outlined" />}
            <Typography variant="caption" color="text.secondary">{dateOf(post.createdAt)}</Typography>
          </Stack>
        </Box>
        <Button size="small" disabled={operation.busy} onClick={() => operation.run(() => invoke(actions, 'hide', post), () => { setLocalHidden(true); onHide?.(post); })}>Hide</Button>
      </Stack>
      {post.body && <Typography sx={{ mt: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{post.body}</Typography>}
      {post.caption && <Typography sx={{ mt: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{post.caption}</Typography>}
      <Media post={post} actions={actions} />
      <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2 }}>
        <Button size="small" disabled={operation.busy || data.offline} onClick={() => operation.run(() => invoke(actions, 'vote', post, 'up'))}>Lift</Button>
        <Button size="small" disabled={operation.busy || data.offline} onClick={() => operation.run(() => invoke(actions, 'vote', post, 'down'))}>Lower</Button>
        {!detail && <Button size="small" onClick={openPost}>Open conversation</Button>}
      </Stack>
      {detail && <PresentReactions post={post} actions={actions} />}

      {detail && <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }} onSubmit={(event) => {
        event.preventDefault();
        if (emoji.trim()) operation.run(() => invoke(actions, 'react', post, emoji.trim()), () => setEmoji(''));
      }}>
        <TextField size="small" label="Your emoji" value={emoji} onChange={(event) => setEmoji(event.target.value)} inputProps={{ 'aria-label': 'Your emoji' }} helperText="Type any emoji." />
        <Button type="submit" variant="outlined" disabled={!emoji.trim() || operation.busy || data.offline}>React</Button>
      </Stack>}
      {operation.error && <Alert severity="error" sx={{ mt: 1 }}>{operation.error}</Alert>}
    </CardContent>
  </Card>;
}

function Heading({ title, subtitle }) {
  return <Box sx={{ mb: 3 }}><Typography variant="h4" component="h1" fontWeight={700}>{title}</Typography>{subtitle && <Typography color="text.secondary">{subtitle}</Typography>}</Box>;
}

function Feed({ posts, data, actions, navigate, empty, hidden, onHide }) {
  const visible = rows(posts).filter((post) => visibleAtOrigin(post, data) && !hidden?.has(postKey(post)) && !actions?.isHidden?.(post));
  return visible.length ? <Stack spacing={2}>{visible.map((post, index) => <PostCard key={postKey(post) || index} post={post} data={data} actions={actions} navigate={navigate} onHide={onHide} />)}</Stack> : <Alert severity="info">{empty}</Alert>;
}

export function Timeline({ data = {}, actions = {}, navigate }) {
  const posts = rows(data.posts);
  const ranked = rows(data.ranked);
  const [hidden, setHidden] = useState(() => new Set());
  const onHide = (post) => setHidden((current) => new Set(current).add(postKey(post)));
  return <Box>
    <Heading title="Timeline" subtitle="The latest moments from your connected families" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Saved moments may be out of date; new activity is not available until you reconnect.</Alert>}
    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 3 }}><Button variant="contained" onClick={() => navigate?.('/compose')}>Create a post</Button><Button variant="outlined" onClick={() => navigate?.('/search')}>Search moments</Button><Button variant="outlined" onClick={() => navigate?.('/albums')}>Albums</Button></Stack>
    <Typography variant="h6" sx={{ mb: 1 }}>Latest activity</Typography>
    <Feed posts={posts} data={data} actions={actions} navigate={navigate} hidden={hidden} onHide={onHide} empty={data.offline ? 'No saved moments are available.' : 'Nothing here yet. Start the conversation.'} />
    <Divider sx={{ my: 4 }} />
    <Typography variant="h6" sx={{ mb: 1 }}>Worth a look</Typography>
    <Feed posts={ranked} data={data} actions={actions} navigate={navigate} hidden={hidden} onHide={onHide} empty={data.offline ? 'Highlights are unavailable while a family server is unreachable.' : 'No highlighted posts yet.'} />
  </Box>;
}

export function Groups({ data = {}, actions = {}, navigate, id, routeId }) {
  const selectedId = id ?? routeId;
  const groups = (Array.isArray(data.groups) ? data.groups : []).filter((item) => groupAtOrigin(item, data));
  const [loaded, setLoaded] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!selectedId || data.offline) return undefined;
    if (!actions.loadGroup) { setLoadError('This group timeline cannot be loaded from your family server yet.'); return undefined; }
    let current = true;
    setLoaded(null);
    setLoading(true);
    setLoadError('');
    Promise.resolve().then(() => actions.loadGroup(selectedId))
      .then((result) => {
        if (!result?.group || !Array.isArray(result.posts)) throw new Error('The family server did not return this group timeline.');
        if (current) { setLoaded({ ...result, id: selectedId }); setLoading(false); }
      })
      .catch((error) => { if (current) { setLoadError(messageOf(error)); setLoading(false); } });
    return () => { current = false; };
  }, [selectedId, data.offline, actions.loadGroup]);
  const current = loaded?.id === selectedId ? loaded : null;
  const group = current?.group ?? groups.find((item) => identityOf(item) === String(selectedId));
  const posts = current ? rows(current.posts).map((post) => atCurrentOrigin(post, data)) : rows(data.posts).filter((post) => String(post.groupId ?? '') === String(selectedId) && (!group?.networkId || String(originOf(post)) === String(group.networkId)));
  return <Box>
    <Heading title={group?.name ?? 'Groups'} subtitle="Spaces within your family network" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Groups may be out of date while your family server is unreachable.</Alert>}
    {selectedId && <Button sx={{ mb: 2 }} onClick={() => navigate?.('/groups')}>All groups</Button>}
    {loading && <CircularProgress aria-label="Loading group" size={24} />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {selectedId && !group && !loading && !loadError && <Alert severity="info">{data.offline ? 'This group is not saved on this device. Reconnect to check it.' : 'This group is not available in your network.'}</Alert>}
    {group && !loading && !loadError && <Stack spacing={2}>
      <Typography color="text.secondary">Posts in {group.name} stay within {data.network?.name ?? 'this family network'}. Each post shows its origin.</Typography>
      <Feed posts={posts} data={data} actions={actions} navigate={navigate} empty={data.offline ? 'No saved posts from this group are available.' : 'No posts in this group yet.'} />
    </Stack>}
    {!selectedId && (groups.length ? <Stack spacing={2}>{groups.map((item) => <Card key={identityOf(item)} variant="outlined"><CardContent><Typography variant="h6">{item.name}</Typography><Typography color="text.secondary">Within {data.network?.name ?? 'this family network'}</Typography><Button onClick={() => navigate?.(`/groups/${encodeURIComponent(identityOf(item))}`)}>View group</Button></CardContent></Card>)}</Stack> : <Alert severity="info">{data.offline || data.availability?.groups === false ? 'Groups cannot be loaded from your family server right now.' : 'No groups have been created on this family server.'}</Alert>)}
  </Box>;
}

function ReplyForm({ label, onSubmit, offline }) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState('');
  const operation = useOperation();
  return <Stack component="form" spacing={1} sx={{ my: 1 }} onSubmit={(event) => {
    event.preventDefault();
    if (text.trim()) operation.run(() => onSubmit(text.trim(), mentionsOf(mentions)), () => { setText(''); setMentions(''); });
  }}>
    <TextField label={label} value={text} onChange={(event) => setText(event.target.value)} multiline minRows={2} />
    <TextField size="small" label="Mention member IDs (optional)" value={mentions} onChange={(event) => setMentions(event.target.value)} helperText="Separate IDs with commas. Only members at this post's origin can be mentioned." />
    <Button type="submit" variant="contained" disabled={offline || operation.busy || !text.trim()} sx={{ alignSelf: 'flex-start' }}>{operation.busy ? 'Sending…' : 'Send reply'}</Button>
    {operation.error && <Alert severity="error">{operation.error}</Alert>}
  </Stack>;
}

function Reply({ reply, depth, children, onReply, offline, data }) {
  const [editing, setEditing] = useState(false);
  return <Box sx={{ ml: { xs: Math.min(depth, 3) * 1.5, sm: Math.min(depth, 4) * 3 }, pl: 2, py: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
    <Typography variant="subtitle2">{reply.author?.name ?? reply.authorName ?? memberName(reply.authorDid, data)} <Typography component="span" variant="caption" color="text.secondary">{dateOf(reply.createdAt)}</Typography></Typography>
    <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reply.body}</Typography>
    {depth < 8 && <Button size="small" onClick={() => setEditing(!editing)}>Reply</Button>}
    {editing && <ReplyForm label="Your reply" offline={offline} onSubmit={(body, mentions) => onReply(body, identityOf(reply), mentions)} />}
    {children}
  </Box>;
}

export function PostDetail({ data = {}, actions = {}, navigate, id, routeId }) {
  const selectedId = id ?? routeId;
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!selectedId) { setLoading(false); return undefined; }
    if (data.offline) { setLoading(false); return undefined; }
    let current = true;
    setLoading(true);
    setThread(null);
    setLoadError('');
    Promise.resolve().then(async () => {
      const postResult = await invoke(actions, 'loadPost', selectedId);
      if (!postResult?.post || identityOf(postResult.post) !== String(selectedId)) throw new Error('The family server did not return this post.');
      const commentsResult = await invoke(actions, 'loadComments', postResult.post);
      if (!Array.isArray(commentsResult?.comments)) throw new Error('The family server did not return this conversation.');
      return { id: selectedId, post: postResult.post, comments: commentsResult.comments };
    }).then((result) => { if (current) { setThread(result); setLoading(false); } })
      .catch((error) => { if (current) { setLoadError(messageOf(error)); setLoading(false); } });
    return () => { current = false; };
  }, [selectedId, data.offline, actions.loadPost, actions.loadComments]);
  const saved = data.offline ? rows(data.posts).find((item) => identityOf(item) === String(selectedId)) : null;
  const post = thread?.id === selectedId ? thread.post : saved;
  const comments = thread?.id === selectedId ? thread.comments : [];
  const replies = comments.filter((reply) => (!reply.postId || reply.postId === identityOf(post)) && (!reply.networkId || !originOf(post) || String(reply.networkId) === String(originOf(post))));
  const byParent = new Map();
  for (const reply of replies) {
    const key = reply.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(reply);
  }
  const submit = async (body, parentId, mentions) => {
    const result = await invoke(actions, 'submitReply', post, body, parentId, mentions);
    if (!result?.comment || identityOf(result.comment) === '' || result.comment.postId !== identityOf(post)) throw new Error('The family server did not confirm this reply. Reload the conversation before trying again.');
    setThread((current) => current?.id === selectedId ? { ...current, comments: [...current.comments, result.comment] } : current);
    return result;
  };
  const renderReplies = (parentId = '', depth = 0, seen = new Set()) => (byParent.get(parentId) || []).filter((reply) => !seen.has(identityOf(reply))).map((reply, index) => {
    const nextSeen = new Set(seen);
    nextSeen.add(identityOf(reply));
    return <Reply key={identityOf(reply) || index} reply={reply} depth={depth} offline={data.offline} data={data} onReply={submit}>{renderReplies(identityOf(reply), depth + 1, nextSeen)}</Reply>;
  });
  return <Box>
    <Button onClick={() => navigate?.('/timeline')} sx={{ mb: 2 }}>Back to timeline</Button>
    <Heading title="Conversation" />
    {loading && !data.offline && <CircularProgress aria-label="Loading conversation" />}
    {loadError && <Alert severity="error">{loadError}</Alert>}
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>The conversation cannot refresh while your family server is unreachable. Only a saved post, if available, is shown.</Alert>}
    {!loading && !loadError && (!post || !visibleAtOrigin(post, data)) && <Alert severity="info">This post is not available in your network.</Alert>}
    {post && visibleAtOrigin(post, data) && !loadError && <Stack spacing={2}>
      <PostCard post={post} data={data} actions={actions} navigate={navigate} detail onHide={() => navigate?.('/timeline')} />
      <Typography variant="h6">Replies</Typography>
      {!data.offline && (replies.length ? renderReplies() : <Typography color="text.secondary">Be the first to reply.</Typography>)}
      {!data.offline && <ReplyForm label="Write a reply" onSubmit={(body, mentions) => submit(body, null, mentions)} />}
    </Stack>}
  </Box>;
}

function mediaIds(result) {
  const values = Array.isArray(result) ? result : Array.isArray(result?.mediaRefs) ? result.mediaRefs : Array.isArray(result?.media) ? result.media : result?.mediaId || result?._id ? [result] : [];
  return values.map((entry) => typeof entry === 'string' ? entry : entry?.mediaId ?? entry?._id ?? entry?.id).filter(Boolean);
}

export function Compose({ open, onClose, data = {}, actions = {} }) {
  const [type, setType] = useState('text');
  const [body, setBody] = useState('');
  const [caption, setCaption] = useState('');
  const [groupId, setGroupId] = useState('');
  const [files, setFiles] = useState([]);
  const operation = useOperation();
  const reset = () => { setBody(''); setCaption(''); setFiles([]); setGroupId(''); setType('text'); };
  const mediaType = type !== 'text';
  const groups = (Array.isArray(data.groups) ? data.groups : []).filter((group) => groupAtOrigin(group, data));
  return <Dialog open={Boolean(open)} onClose={operation.busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="compose-title">
    <DialogTitle id="compose-title">Create a post</DialogTitle>
    <Box component="form" onSubmit={(event) => {
      event.preventDefault();
      if (data.offline || (!mediaType && !body.trim()) || (mediaType && !files.length)) return;
      operation.run(async () => {
        let mediaRefs = [];
        if (mediaType) {
          mediaRefs = mediaIds(await invoke(actions, 'upload', files));
          if (mediaRefs.length !== files.length || new Set(mediaRefs).size !== files.length) throw new Error('Could not attach every original. Check your uploads before trying again.');
        }
        const result = await invoke(actions, 'submitPost', { type, body: mediaType ? null : body.trim(), caption: mediaType ? caption.trim() || null : null, mediaRefs, groupId: groupId || null });
        if (!result?.post || !identityOf(result.post)) throw new Error('The family server did not confirm this post. Refresh your timeline before trying again.');
        return result;
      }, () => { reset(); onClose?.(); });
    }}>
      <DialogContent><Stack spacing={2}>
        {data.offline && <Alert severity="warning">Posting is unavailable while your family server is unreachable. Your draft stays here.</Alert>}
        <FormControl fullWidth><InputLabel id="post-type-label">Post type</InputLabel><Select labelId="post-type-label" label="Post type" value={type} onChange={(event) => { setType(event.target.value); setFiles([]); }}><MenuItem value="text">Text</MenuItem><MenuItem value="photo">Photo</MenuItem><MenuItem value="video">Video</MenuItem><MenuItem value="audio">Audio</MenuItem></Select></FormControl>
        {groups.length > 0 && <FormControl fullWidth><InputLabel id="post-group-label">Group (optional)</InputLabel><Select labelId="post-group-label" label="Group (optional)" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">Entire network</MenuItem>{groups.map((group) => <MenuItem key={identityOf(group)} value={identityOf(group)}>{group.name}</MenuItem>)}</Select></FormControl>}
        {mediaType ? <><Button variant="outlined" component="label">Choose {type}<input hidden type="file" accept={type === 'photo' ? 'image/*' : `${type}/*`} multiple={type === 'photo'} onChange={(event) => { setFiles(Array.from(event.target.files || [])); event.target.value = ''; }} /></Button><Typography variant="body2" color="text.secondary">{files.length ? files.map((file) => file.name).join(', ') : 'Choose an original file to upload before publishing.'}</Typography><TextField label="Caption (optional)" multiline minRows={2} value={caption} onChange={(event) => setCaption(event.target.value)} /></> : <TextField autoFocus label="Your post" multiline minRows={4} value={body} onChange={(event) => setBody(event.target.value)} />}
        {operation.error && <Alert severity="error">{operation.error}</Alert>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={operation.busy} onClick={onClose}>Cancel</Button><Button variant="contained" type="submit" disabled={operation.busy || data.offline || (mediaType ? !files.length : !body.trim())}>{operation.busy ? <CircularProgress size={20} color="inherit" /> : 'Publish'}</Button></DialogActions>
    </Box>
  </Dialog>;
}

export function Albums({ navigate }) {
  return <Box>
    <Heading title="Albums" subtitle="Find moments by their album name" />
    <Alert severity="info">This family server can search album names, but does not provide a direct album browsing or organization action yet. Nothing here has been created or changed.</Alert>
    <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2 }}>
      <Button variant="contained" onClick={() => navigate?.('/search')}>Search albums</Button>
      <Button variant="outlined" onClick={() => navigate?.('/uploads')}>Upload originals</Button>
    </Stack>
  </Box>;
}

export function Uploads({ data = {}, navigate, actions = {} }) {
  const [files, setFiles] = useState([]);
  const [complete, setComplete] = useState(false);
  const operation = useOperation();
  return <Box>
    <Heading title="Uploads" subtitle="Add original photos, videos, or audio to your family server" />
    <Alert severity="info" sx={{ mb: 2 }}>Uploading stores originals; it does not publish a post or add anything to an album. Create a post to share a moment.</Alert>
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>A family server is unreachable. Reconnect before uploading.</Alert>}
    <Stack spacing={2}>
      <Button component="label" variant="outlined" sx={{ alignSelf: 'flex-start' }}>Choose files<input hidden multiple type="file" accept="image/*,video/*,audio/*" onChange={(event) => { setFiles(Array.from(event.target.files || [])); setComplete(false); event.target.value = ''; }} /></Button>
      {files.length > 0 && <Typography>{files.map((file) => file.name).join(', ')}</Typography>}
      <Button variant="contained" disabled={!files.length || operation.busy || data.offline} sx={{ alignSelf: 'flex-start' }} onClick={() => operation.run(() => invoke(actions, 'upload', files), (result) => {
        const ids = mediaIds(result);
        if (ids.length !== files.length || new Set(ids).size !== files.length) throw new Error('The family server did not confirm every original. Check your uploads before trying again.');
        setComplete(true);
        setFiles([]);
      })}>{operation.busy ? 'Uploading…' : 'Upload originals'}</Button>
      {complete && <Alert severity="success">Your family server confirmed the original files. They have not been published as a post.</Alert>}
      {operation.error && <Alert severity="error">{operation.error}</Alert>}
      <Button sx={{ alignSelf: 'flex-start' }} onClick={() => navigate?.('/compose')}>Create a post</Button>
    </Stack>
  </Box>;
}

export function Search({ data = {}, actions = {}, navigate }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const operation = useOperation();
  return <Box>
    <Heading title="Search" subtitle="Find captions, people tags, and album names within your family network" />
    {data.offline && <Alert severity="warning" sx={{ mb: 2 }}>Search needs a reachable family server. Saved moments remain on your timeline.</Alert>}
    <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 3 }} onSubmit={(event) => {
      event.preventDefault();
      const text = query.trim();
      if (text && !data.offline) operation.run(() => invoke(actions, 'search', text), (response) => {
        if (!Array.isArray(response?.posts)) throw new Error('The family server did not return search results.');
        setResult({ query: text, posts: response.posts.map((post) => atCurrentOrigin(post, data)) });
      });
    }}>
      <TextField fullWidth label="Search moments" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button variant="contained" type="submit" disabled={!query.trim() || operation.busy || data.offline}>{operation.busy ? 'Searching…' : 'Search'}</Button>
    </Stack>
    {operation.error && <Alert severity="error" sx={{ mb: 2 }}>{operation.error}</Alert>}
    {result && <><Typography variant="h6" sx={{ mb: 2 }}>Results for “{result.query}”</Typography><Feed posts={result.posts} data={data} actions={actions} navigate={navigate} empty="No moments matched that search at this family server." /></>}
  </Box>;
}

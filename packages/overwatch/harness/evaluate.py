import json, itertools, sys

chains = json.load(open("chains.json"))
gt = json.load(open("ground_truth.json"))

# index person sightings by occurrence order within entities
seq_index = {}
for e in chains["entities"]:
    for s in e["sightings"]:
        if s.get("cls") != "person":
            continue
        seq_index[s["seq"]] = {"entityId": e["entityId"], "sighting": s}

def per_camera_tracks(chains):
    """all person sightings flattened"""
    out = []
    for e in chains["entities"]:
        for s in e["sightings"]:
            if s.get("cls") == "person":
                out.append((e["entityId"], s))
    return out

def overlap(a0, a1, b0, b1):
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    denom = max(1e-6, min(a1, b1) - max(a0, b0)) if False else max(1e-6, b1 - b0)
    return inter / denom

emitted = per_camera_tracks(chains)
matches = {}
for g in gt["sightings"]:
    cands = [(eid, s, overlap(s["t0"], s["t1"], g["t0"], g["t1"]))
             for eid, s in emitted if s["camera"] == g["camera"] and overlap(s["t0"], s["t1"], g["t0"], g["t1"]) >= 0.5]
    cands.sort(key=lambda c: -c[2])
    matches[g["id"]] = cands

verdicts = {}
for sess in gt["sessions"]:
    groups = {}
    unmatched = []
    for gid in sess["sightings"]:
        cands = matches.get(gid, [])
        if not cands:
            unmatched.append(gid); continue
        groups.setdefault(cands[0][0], set()).add(gid.split("-")[1])
    merged = not unmatched and len(groups) == 1
    verdicts[sess["id"]] = {"merged": merged, "entities": sorted(groups), "unmatched": unmatched}

# join precision restricted to person joins whose BOTH sides match a gt sighting
tp = fp = unanchored = 0
def episodes_of(s):
    found = set()
    for g in gt["sightings"]:
        if g["camera"] == s["camera"] and overlap(s["t0"], s["t1"], g["t0"], g["t1"]) >= 0.5:
            found.add(g["session"])
    return found

for j in chains["joins"]:
    a = seq_index.get(j["fromSeq"]); b = seq_index.get(j["toSeq"])
    if not a or not b:
        continue  # not a person join (cls filtered)
    eps_a, eps_b = episodes_of(a["sighting"]), episodes_of(b["sighting"])
    if not eps_a or not eps_b:
        unanchored += 1
        continue  # at least one side outside labeled evidence
    if eps_a & eps_b:
        tp += 1
    else:
        fp += 1

merged_n = sum(1 for v in verdicts.values() if v["merged"])
print(f"merge correctness: {merged_n}/{len(verdicts)} = {merged_n/len(verdicts):.0%}")
print(f"person join precision (labeled anchors): {tp}/{tp+fp}, unanchored-side joins excluded: {unanchored}")
for sid, v in verdicts.items():
    print(f"  {sid}: {'MERGED' if v['merged'] else 'SPLIT'} entities={v['entities']} unmatched={v['unmatched']}")
json.dump({"merge": merged_n/len(verdicts), "precision": tp/(tp+fp) if tp+fp else None,
           "tp": tp, "fp": fp, "unanchored": unanchored,
           "verdicts": verdicts}, open("metrics.json","w"), indent=1)

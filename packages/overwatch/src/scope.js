// PORCH-140 scope law constants of record.
// TRACKED_CLASSES: persons, vehicles, and the built-in large-object set.
// FOLLOWABLE_CLASSES: only a person or a vehicle can be followed.
export const TRACKED_CLASSES = ["person", "vehicle", "package", "bin", "furniture", "equipment"];
export const FOLLOWABLE_CLASSES = ["person", "vehicle"];

/**
 * Melee damage and base knockback (Terraria “tooltip” scale) for held items.
 * Swords and axes follow tiered values; other tools use weak defaults.
 */
import type { ItemDefinition } from "./itemDefinition";

function isSwordKey(key: string): boolean {
  return key.includes("sword");
}

function isAxeItem(def: ItemDefinition): boolean {
  return def.toolType === "axe" || def.key.includes("axe");
}

/** True when the item is used as a sword/axe in melee (matches {@link Game} reach logic). */
export function isSwordOrAxeMeleeItem(def: ItemDefinition): boolean {
  return isSwordKey(def.key) || isAxeItem(def);
}

/**
 * Melee hit damage (HP) for the held item. Fist and unknown items use 1; Registry required for tools.
 */
export function meleeDamageFromHeldItemId(
  def: ItemDefinition | undefined,
  heldItemId: number,
): number {
  if (heldItemId === 0) {
    return 1;
  }
  if (def === undefined) {
    return 1;
  }
  const key = def.key;
  if (isSwordKey(key)) {
    const tier = def.toolTier;
    if (tier === 0) {
      return 4;
    }
    if (tier === 1) {
      return 5;
    }
    if (tier === 2) {
      return 6;
    }
    if (tier === 3) {
      return 7;
    }
    return 5;
  }
  if (isAxeItem(def)) {
    // Less damage per tier than swords; reward positioning over raw DPS.
    const tier = def.toolTier;
    if (tier === 0) {
      return 3;
    }
    if (tier === 1) {
      return 4;
    }
    if (tier === 2) {
      return 5;
    }
    if (tier === 3) {
      return 6;
    }
    return 4;
  }
  return 1;
}

/**
 * Terraria weapon knockback before mob resist / soft caps (see wiki.gg/Knockback).
 */
export function meleeBaseKnockbackFromHeldItemId(
  def: ItemDefinition | undefined,
  heldItemId: number,
): number {
  if (heldItemId === 0) {
    return 2.85;
  }
  if (def === undefined) {
    return 3.35;
  }
  const key = def.key;
  if (isSwordKey(key)) {
    const tier = def.toolTier;
    if (tier === 0) {
      return 5.2;
    }
    if (tier === 1) {
      return 5.85;
    }
    if (tier === 2) {
      return 6.5;
    }
    if (tier === 3) {
      return 7.75;
    }
    return 5.85;
  }
  if (isAxeItem(def)) {
    // Higher per-tier knockback than swords; trades damage for control.
    const tier = def.toolTier;
    if (tier === 0) {
      return 6.2;
    }
    if (tier === 1) {
      return 6.85;
    }
    if (tier === 2) {
      return 7.5;
    }
    if (tier === 3) {
      return 8.75;
    }
    return 6.85;
  }
  return 3.35;
}

/** Shown in inventory tooltips; null when the item is not a sword/axe. */
export function getMeleeStatsForSwordOrAxeTooltip(
  def: ItemDefinition,
): { damage: number; knockback: number } | null {
  if (!isSwordOrAxeMeleeItem(def)) {
    return null;
  }
  return {
    damage: meleeDamageFromHeldItemId(def, def.id as number),
    knockback: meleeBaseKnockbackFromHeldItemId(def, def.id as number),
  };
}

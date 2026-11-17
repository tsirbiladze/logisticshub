import type { Pack } from "../model.ts";
import { enLedLighting } from "./en-led-lighting.ts";
import { kaOfficeFurniture } from "./ka-office-furniture.ts";
import { ruTextile } from "./ru-textile.ts";
import { trCeramics } from "./tr-ceramics.ts";

export const PACKS: readonly Pack[] = [kaOfficeFurniture, enLedLighting, ruTextile, trCeramics];

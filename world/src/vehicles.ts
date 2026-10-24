import type { VehicleKind, VehicleType } from '../../contracts.ts';
import { VEHICLE_KINDS } from '../../contracts.ts';

/**
 * What drives to Ohio Stadium on game day, at real-world size.
 *
 * Footprints are typical US models — a Civic, an Accord, an Explorer, a crew-cab
 * F-150, an Odyssey, a Class A motorhome, a 45 ft charter coach, a Type III
 * ambulance — because the map draws every vehicle to scale and a bus that looks
 * like a sedan hides exactly the thing a commander needs to see: where the big
 * vehicles block a street. Shares are an assumption, not a count.
 */
export const VEHICLE_TYPES: Record<VehicleKind, VehicleType> = {
  compact: { kind: 'compact', label: 'Compact car', lengthM: 4.6, widthM: 1.8, maxSpeedMps: 13, passengers: 3, share: 0.14 },
  sedan: { kind: 'sedan', label: 'Sedan', lengthM: 4.9, widthM: 1.86, maxSpeedMps: 13, passengers: 3, share: 0.3 },
  suv: { kind: 'suv', label: 'SUV', lengthM: 5.05, widthM: 2.0, maxSpeedMps: 13, passengers: 4, share: 0.26 },
  pickup: { kind: 'pickup', label: 'Pickup truck', lengthM: 5.9, widthM: 2.03, maxSpeedMps: 12.5, passengers: 3, share: 0.12 },
  minivan: { kind: 'minivan', label: 'Minivan', lengthM: 5.2, widthM: 2.0, maxSpeedMps: 12.5, passengers: 5, share: 0.08 },
  rideshare: { kind: 'rideshare', label: 'Rideshare drop-off', lengthM: 4.8, widthM: 1.85, maxSpeedMps: 13, passengers: 3, share: 0.05 },
  motorcycle: { kind: 'motorcycle', label: 'Motorcycle', lengthM: 2.2, widthM: 0.8, maxSpeedMps: 14, passengers: 1, share: 0.02 },
  rv: { kind: 'rv', label: 'RV / motorhome', lengthM: 10.7, widthM: 2.55, maxSpeedMps: 10, passengers: 6, share: 0.015 },
  bus: { kind: 'bus', label: 'Charter bus', lengthM: 13.7, widthM: 2.6, maxSpeedMps: 10, passengers: 50, share: 0.015 },
  police: { kind: 'police', label: 'Police cruiser', lengthM: 5.05, widthM: 2.0, maxSpeedMps: 15, passengers: 2, share: 0 },
  ambulance: { kind: 'ambulance', label: 'Ambulance', lengthM: 7.0, widthM: 2.4, maxSpeedMps: 14, passengers: 2, share: 0 },
};

export const VEHICLE_TYPE_LIST: VehicleType[] = VEHICLE_KINDS.map((kind) => VEHICLE_TYPES[kind]);

/** Large vehicles park along a row across several stalls instead of nose-in to one. */
export const isLongVehicle = (kind: VehicleKind) => VEHICLE_TYPES[kind].lengthM > 7;

/** Default sample of general traffic. Sized to what the mapped, road-connected lots can hold. */
export const DEFAULT_VEHICLES = 4500;

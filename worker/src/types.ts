import type { Context } from 'hono';

export type Role = 'admin' | 'attendant';
export type FuelType = 'PETROL' | 'DIESEL';

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  FRONTEND_ORIGINS?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_FULL_NAME?: string;
}

export interface WorkerConfig {
  schemaVersion: 2;
  jwtSecret: string;
  origins: readonly string[];
  bcryptRounds: number;
  standardBodyLimit: number;
  restoreBodyLimit: number;
  loginWindowMs: number;
  loginMaxFailures: number;
  loginBlockMs: number;
}

export interface AuthUser extends DbRow {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  is_active: number;
  session_version: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export type AppVariables = {
  requestId: string;
  auth: AuthUser;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppEnv, any, any>;
export type DbRow = Record<string, string | number | ArrayBuffer | null>;
export type BindValue = string | number | ArrayBuffer | null;

export interface UserRow extends DbRow {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: Role;
  is_active: number;
  session_version: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface FuelRow extends DbRow {
  id: number;
  fuel_type: FuelType;
  quantity: number;
  weighted_average_cost_cents: number;
  selling_price_cents: number;
  price_per_litre: number;
  stock_litres: number;
  tank_capacity_litres: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface PumpRow extends DbRow {
  id: number;
  fuel_id: number;
  fuel_type: FuelType;
  pump_code: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export function requiredText(value: string, label: string, max = 500): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  if (trimmed.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

export function positiveNumber(value: string, label: string): string | null {
  if (!value.trim()) return `${label} is required.`;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return `${label} must be greater than zero.`;
  return null;
}

export function nonNegativeNumber(value: string, label: string): string | null {
  if (!value.trim()) return `${label} is required.`;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return `${label} cannot be negative.`;
  return null;
}

export function nonZeroNumber(value: string, label: string): string | null {
  if (!value.trim()) return `${label} is required.`;
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return `${label} must not be zero.`;
  return null;
}

export function isoDate(value: string, label: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00`).getTime())) {
    return `${label} must be a valid date.`;
  }
  return null;
}

export function dateRangeError(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both a start and end date.';
  if (from > to) return 'The end date cannot be before the start date.';
  return null;
}

export function passwordError(value: string, label = 'Password'): string | null {
  if (value.length < 12) return `${label} must be at least 12 characters.`;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return `${label} must include upper and lower case letters, a number, and a symbol.`;
  }
  return null;
}

export function usernameError(value: string): string | null {
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(value)) return 'Use 3–32 letters, numbers, dots, underscores, or hyphens.';
  return null;
}

export function firstError(...errors: Array<string | null>): string | null {
  return errors.find(Boolean) || null;
}

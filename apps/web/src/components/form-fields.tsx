"use client";

import { useId, type ReactNode } from "react";
import type { FieldError, FieldValues, Path, UseFormRegister } from "react-hook-form";

type FieldProps<T extends FieldValues> = {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  error?: FieldError | undefined;
  type?: string | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
};

const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none";

/**
 * `htmlFor` uses a generated id rather than the field name: two forms on the
 * same page can legitimately share a field name (a site and a domain both have
 * a "name"), and duplicate DOM ids silently point one form's label at the
 * other form's input.
 */
function Wrapper({
  id, label, error, children,
}: { id: string; label: string; error?: FieldError | undefined; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-700">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

export function TextField<T extends FieldValues>({ name, label, register, error, type = "text", placeholder, required }: FieldProps<T>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error}>
      <input id={id} type={type} placeholder={placeholder} required={required} className={CONTROL} {...register(name)} />
    </Wrapper>
  );
}

export function TextAreaField<T extends FieldValues>({ name, label, register, error, placeholder }: FieldProps<T>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error}>
      <textarea id={id} rows={3} placeholder={placeholder} className={`${CONTROL} h-auto py-2`} {...register(name)} />
    </Wrapper>
  );
}

export function SelectField<T extends FieldValues>({
  name, label, register, error, options,
}: FieldProps<T> & { options: readonly { value: string; label: string }[] }) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error}>
      <select id={id} className={CONTROL} {...register(name)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Wrapper>
  );
}

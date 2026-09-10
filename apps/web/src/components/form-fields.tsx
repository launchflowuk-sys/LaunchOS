"use client";

import { useId, type ReactNode } from "react";
import type { FieldError, FieldValues, Path, UseFormRegister } from "react-hook-form";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type FieldProps<T extends FieldValues> = {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  error?: FieldError | undefined;
  type?: string | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  /**
   * A line under the field explaining what it decides. For fields whose label
   * cannot carry the meaning on its own — a number of days is not self-evidently
   * days *before* something rather than after.
   */
  hint?: string | undefined;
};

/**
 * `htmlFor` uses a generated id rather than the field name: two forms on the
 * same page can legitimately share a field name (a site and a domain both have
 * a "name"), and duplicate DOM ids silently point one form's label at the
 * other form's input.
 */
function Wrapper({
  id, label, error, hint, children,
}: { id: string; label: string; error?: FieldError | undefined; hint?: string | undefined; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {/* The hint stays visible when there is an error: the error says what is
          wrong, the hint says what the field is for, and a person correcting a
          value needs both. */}
      {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-meta text-danger-fg">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

export function TextField<T extends FieldValues>({ name, label, register, error, type = "text", placeholder, required, hint }: FieldProps<T>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error} hint={hint}>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        required={required}
        aria-invalid={error ? true : undefined}
        {...register(name)}
      />
    </Wrapper>
  );
}

export function TextAreaField<T extends FieldValues>({ name, label, register, error, placeholder }: FieldProps<T>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error}>
      <Textarea
        id={id}
        rows={3}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        {...register(name)}
      />
    </Wrapper>
  );
}

export function SelectField<T extends FieldValues>({
  name, label, register, error, options,
}: FieldProps<T> & { options: readonly { value: string; label: string }[] }) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} error={error}>
      <NativeSelect id={id} aria-invalid={error ? true : undefined} {...register(name)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </Wrapper>
  );
}

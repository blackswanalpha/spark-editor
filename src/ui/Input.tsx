import { forwardRef, type InputHTMLAttributes } from "react";
import { Icon } from "./Icon";
import "./Input.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  leadingIcon?: string;
  trailingIcon?: string;
  inputSize?: "sm" | "md";
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingIcon, trailingIcon, inputSize = "md", invalid, className, ...rest },
  ref,
) {
  return (
    <div
      className={[
        "input",
        `input--${inputSize}`,
        invalid && "is-invalid",
        className,
      ].filter(Boolean).join(" ")}
    >
      {leadingIcon && <Icon name={leadingIcon} className="input__lead" size={14} />}
      <input ref={ref} className="input__el" {...rest} />
      {trailingIcon && <Icon name={trailingIcon} className="input__trail" size={14} />}
    </div>
  );
});

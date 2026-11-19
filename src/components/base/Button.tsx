import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

export const Button = ({
  variant = 'primary',
  size = 'l',
  block = false,
  icon,
  className,
  children,
  ...props
}: {
  variant?: 'primary' | 'outlined' | 'danger' | 'dangerOutlined'
  size?: 'l' | 'm' | 's'
  block?: boolean
  /** 前置图标，与文字垂直居中对齐 */
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    className={clsx(styles.button, styles[variant], styles[size], block && styles.block, className)}
    {...props}
  >
    {icon ? <span className={styles.icon}>{icon}</span> : null}
    {children}
  </button>
)
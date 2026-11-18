variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Prefix for all resource names"
  type        = string
  default     = "cookie-orders"
}

variable "shop_name" {
  description = "Title shown on the order page"
  type        = string
  default     = "Cookie Orders"
}

variable "timezone" {
  description = "Used to hide past pickup dates and show order times"
  type        = string
  default     = "America/Chicago"
}

variable "pickup_slots" {
  description = "Pickup dates (YYYY-MM-DD) mapped to the max number of orders for that date. Set a date to 0 to close it."
  type        = map(number)

  validation {
    condition     = alltrue([for d in keys(var.pickup_slots) : can(regex("^\\d{4}-\\d{2}-\\d{2}$", d))])
    error_message = "Pickup dates must look like 2026-12-19."
  }
}

variable "admin_key" {
  description = "Secret for the /orders page. Use a long random string."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.admin_key) >= 16
    error_message = "Use at least 16 characters."
  }
}

variable "reserved_concurrency" {
  description = "Caps simultaneous Lambda runs to limit abuse. -1 = no cap. New AWS accounts often can't reserve any; leave -1 if apply fails."
  type        = number
  default     = -1
}

variable "budget_email" {
  description = "Email for the cost alert. Leave empty to skip the budget."
  type        = string
  default     = ""
}

variable "budget_limit_usd" {
  type    = string
  default = "1"
}

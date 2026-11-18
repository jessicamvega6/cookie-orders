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
  default     = "Operation: Bake It Off"
}

variable "timezone" {
  description = "Used for order cutoffs and to show order times"
  type        = string
  default     = "America/Chicago"
}

variable "delivery_windows" {
  description = "Delivery weeks, keyed by the week's first date. limit = boxes for the whole week, shared by all its dates. Set limit to 0 to close a week."
  type = map(object({
    dates = list(string)
    limit = number
  }))

  validation {
    condition = alltrue(flatten([
      for id, w in var.delivery_windows : concat(
        [can(regex("^\\d{4}-\\d{2}-\\d{2}$", id)), length(w.dates) > 0, contains(w.dates, id)],
        [for d in w.dates : can(regex("^\\d{4}-\\d{2}-\\d{2}$", d))]
      )
    ]))
    error_message = "Each week's key must be its first delivery date, and all dates must look like 2026-12-06."
  }
}

variable "order_cutoff_days" {
  description = "Orders for a week close at the end of the day (in var.timezone) this many days before the week's first delivery date."
  type        = number
  default     = 3
}

variable "order_retention_days" {
  description = "Orders (with customers' names, phones and addresses) are deleted automatically this many days after their delivery date."
  type        = number
  default     = 30

  validation {
    condition     = var.order_retention_days >= 1 && floor(var.order_retention_days) == var.order_retention_days
    error_message = "Use a whole number of days, 1 or more."
  }
}

variable "admin_key" {
  description = "Password for the /orders page. Use a long random string. Changing it signs everyone out."
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

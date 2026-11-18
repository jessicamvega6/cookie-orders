output "order_page_url" {
  description = "Share this with customers"
  value       = aws_lambda_function_url.app.function_url
}

output "orders_admin_url" {
  description = "Your friend's order list. Keep it private."
  value       = "${trimsuffix(aws_lambda_function_url.app.function_url, "/")}/orders?key=${var.admin_key}"
  sensitive   = true
}

output "order_page_url" {
  description = "Share this with customers"
  value       = aws_lambda_function_url.app.function_url
}

output "orders_admin_url" {
  description = "Your friend's order list. It asks for admin_key as a password."
  value       = "${trimsuffix(aws_lambda_function_url.app.function_url, "/")}/orders"
}

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.18" # needs invoked_via_function_url on aws_lambda_permission
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.name }
  }
}

# ---------------- DynamoDB (on-demand = pay per request, no idle cost) ----------------

resource "aws_dynamodb_table" "orders" {
  name         = "${var.name}-orders"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "orderId"

  attribute {
    name = "orderId"
    type = "S"
  }

  # Free safety net so a stray `terraform destroy` can't wipe the orders.
  # Set to false first if you really want to delete the table.
  deletion_protection_enabled = true
}

# One row per pickup date: { pickupDate, orderCount }. Created by the Lambda on first order.
resource "aws_dynamodb_table" "pickup_counts" {
  name         = "${var.name}-pickup-counts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pickupDate"

  attribute {
    name = "pickupDate"
    type = "S"
  }
}

# ---------------- Lambda ----------------

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.mjs"
  output_path = "${path.module}/build/lambda.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${var.name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.name}-lambda"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.orders.arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.pickup_counts.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      }
    ]
  })
}

# Created up front so logs expire after a week instead of being kept (and billed) forever.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = 7
}

resource "aws_lambda_function" "app" {
  function_name    = var.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x" # AWS SDK v3 is built in, so nothing to bundle
  handler          = "index.handler"
  architectures    = ["arm64"] # ~20% cheaper than x86
  memory_size      = 128       # smallest size
  timeout          = 10
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      ORDERS_TABLE = aws_dynamodb_table.orders.name
      COUNTS_TABLE = aws_dynamodb_table.pickup_counts.name
      PICKUP_SLOTS = jsonencode(var.pickup_slots)
      ADMIN_KEY    = var.admin_key
      TIMEZONE     = var.timezone
      SHOP_NAME    = var.shop_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.lambda]
}

# Free HTTPS endpoint, no API Gateway needed.
resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = "NONE"
}

# Since Oct 2025, public function URLs need both of these.
resource "aws_lambda_permission" "url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "invoke_via_url" {
  statement_id             = "AllowInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.app.function_name
  principal                = "*"
  invoked_via_function_url = true # only through the URL, not the raw Invoke API
}

# ---------------- Cost alarm ----------------

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_email == "" ? 0 : 1
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = var.budget_limit_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

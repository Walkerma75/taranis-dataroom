@echo off
REM ============================================================
REM Taranis Data Room — Set up S3 document storage for ECS
REM Run ONCE before deploying to enable persistent file storage.
REM ============================================================

set AWS_REGION=eu-west-2
set AWS_ACCOUNT_ID=571600836975
set S3_BUCKET=taranis-dataroom-documents-prod

echo.
echo === Step 1: Create IAM policy for S3 access ===

REM Write policy JSON to temp file
echo {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::%S3_BUCKET%/*"},{"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::%S3_BUCKET%"}]} > s3-policy.json

aws iam create-policy --policy-name taranis-dataroom-s3-access --policy-document file://s3-policy.json --region %AWS_REGION%
if errorlevel 1 (
    echo NOTE: Policy may already exist, continuing...
)
del s3-policy.json

echo.
echo === Step 2: Create ECS task role ===

echo {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]} > trust-policy.json

aws iam create-role --role-name taranis-dataroom-task-role --assume-role-policy-document file://trust-policy.json --region %AWS_REGION%
if errorlevel 1 (
    echo NOTE: Role may already exist, continuing...
)
del trust-policy.json

echo.
echo === Step 3: Attach S3 policy to task role ===
aws iam attach-role-policy --role-name taranis-dataroom-task-role --policy-arn arn:aws:iam::%AWS_ACCOUNT_ID%:policy/taranis-dataroom-s3-access

echo.
echo === Step 4: Get current task definition ===
aws ecs describe-task-definition --task-definition taranis-dataroom --query taskDefinition --output json --region %AWS_REGION% > current-task-def.json

echo.
echo === Step 5: Register updated task definition with S3 support ===

REM Use PowerShell to modify the task definition JSON
powershell -Command "$td = Get-Content current-task-def.json | ConvertFrom-Json; $td | Add-Member -NotePropertyName taskRoleArn -NotePropertyValue 'arn:aws:iam::%AWS_ACCOUNT_ID%:role/taranis-dataroom-task-role' -Force; $apiContainer = $td.containerDefinitions | Where-Object { $_.name -eq 'api' }; $s3Env = @{name='S3_BUCKET'; value='%S3_BUCKET%'}; $regionEnv = @{name='AWS_REGION'; value='%AWS_REGION%'}; if ($apiContainer.environment -eq $null) { $apiContainer | Add-Member -NotePropertyName environment -NotePropertyValue @() -Force }; $envList = [System.Collections.ArrayList]@($apiContainer.environment | Where-Object { $_.name -ne 'S3_BUCKET' -and $_.name -ne 'AWS_REGION' }); $envList.Add($s3Env) | Out-Null; $envList.Add($regionEnv) | Out-Null; $apiContainer.environment = $envList.ToArray(); $newTd = @{family=$td.family; taskRoleArn=$td.taskRoleArn; executionRoleArn=$td.executionRoleArn; networkMode=$td.networkMode; containerDefinitions=$td.containerDefinitions; requiresCompatibilities=$td.requiresCompatibilities; cpu=$td.cpu; memory=$td.memory}; $newTd | ConvertTo-Json -Depth 10 | Set-Content new-task-def.json"

aws ecs register-task-definition --cli-input-json file://new-task-def.json --region %AWS_REGION%
if errorlevel 1 (
    echo ERROR: Failed to register new task definition.
    pause
    exit /b 1
)

del current-task-def.json
del new-task-def.json

echo.
echo ============================================================
echo SUCCESS! S3 storage is now configured.
echo.
echo Now run deploy.bat to build and deploy with S3 support.
echo ============================================================
pause

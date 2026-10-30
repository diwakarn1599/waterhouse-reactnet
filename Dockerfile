# =============================================================================
# Waterhouse — container image
# =============================================================================
# Builds the React UI and the API in one go, so a host only needs this file.
#
# Deliberately multi-stage: the Node toolchain and the .NET SDK (together well
# over 1 GB) stay in the build stages and never reach the published image, which
# carries only the ASP.NET runtime and the compiled output.
# =============================================================================

# ---- 1. UI ------------------------------------------------------------------
FROM node:22-alpine AS ui
# The working directory mirrors the repo layout on purpose. vite.config.ts
# writes to the RELATIVE path ../Waterhouse.Api/wwwroot, so building from
# /src/web lands the output at /src/Waterhouse.Api/wwwroot. Build from anywhere
# else and the output silently appears somewhere the next stage will not find.
WORKDIR /src/web

# package files first so `npm ci` is cached and only re-runs when deps change.
COPY src/web/package.json src/web/package-lock.json* ./
RUN npm ci

COPY src/web/ ./
RUN npm run build && test -f /src/Waterhouse.Api/wwwroot/index.html


# ---- 2. API -----------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src

COPY src/Waterhouse.Api/Waterhouse.Api.csproj ./Waterhouse.Api/
RUN dotnet restore ./Waterhouse.Api/Waterhouse.Api.csproj

COPY src/Waterhouse.Api/ ./Waterhouse.Api/
# The built UI, served as static files from the same origin as the API.
COPY --from=ui /src/Waterhouse.Api/wwwroot ./Waterhouse.Api/wwwroot

RUN dotnet publish ./Waterhouse.Api/Waterhouse.Api.csproj \
      -c Release -o /app --no-restore


# ---- 3. Runtime -------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=api /app ./

# Writable location for the SQLite file. On a host without a persistent volume
# this lives only for the life of the container — fine for a test instance,
# since the schema and seed data are recreated on every start.
RUN mkdir -p /data
ENV Database__Path=/data/waterhouse.db

ENV ASPNETCORE_ENVIRONMENT=Production
ENV Business__TimeZone=+05:30

# Most free hosts inject PORT at runtime; Program.cs bridges it to Kestrel.
# This default covers hosts that do not set one.
ENV PORT=8080
EXPOSE 8080

# Not root. Costs nothing and keeps an exploited process away from the image.
RUN useradd --system --uid 1001 waterhouse && chown -R waterhouse:waterhouse /data /app
USER waterhouse

ENTRYPOINT ["dotnet", "Waterhouse.Api.dll"]

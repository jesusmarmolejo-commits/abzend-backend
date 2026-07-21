# ABZEND Backup - Setup & Documentation

Sistema automático de backups diarios de la base de datos Supabase a Google Drive con reintentos automáticos.

## 📋 Requisitos previos

- **GitHub Repository**: Acceso a secretos del repositorio
- **Supabase Project**: URL y Service Role Key
- **Google Cloud Project**: Service Account con acceso a Google Drive
- **Google Drive**: Carpeta destino para los backups

## 🔧 Configuración paso a paso

### 1. Obtener credenciales de Supabase

1. Ve a [Supabase Dashboard](https://app.supabase.com)
2. Selecciona tu proyecto ABZEND
3. Dirígete a **Settings** → **API**
4. Copia:
   - **Project URL** → `SUPABASE_URL`
   - **Service Role Key** → `SUPABASE_SERVICE_ROLE_KEY` (⚠️ Mantén esto privado)

### 2. Crear Service Account en Google Cloud

1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Crea un nuevo proyecto o selecciona uno existente
3. Dirígete a **Service Accounts** (en el menú lateral)
4. Crea una nueva service account:
   - Nombre: `abzend-backup`
   - Otórga el rol: `Editor` (o crea rol custom con Drive access)
5. En la cuenta de servicio, ve a **Keys**
6. Crea una nueva clave JSON:
   - Descarga el JSON completo
   - Copia el contenido → `GOOGLE_SERVICE_ACCOUNT_JSON`

### 3. Crear carpeta en Google Drive

1. Abre [Google Drive](https://drive.google.com)
2. Crea una nueva carpeta: `ABZEND-Backups`
3. Comparte la carpeta con el email de la service account (está en el JSON descargado)
4. Copia el ID de la carpeta desde la URL:
   ```
   https://drive.google.com/drive/folders/[FOLDER_ID_AQUI]
   ```
   → `GOOGLE_DRIVE_FOLDER_ID`

### 4. Configurar email de notificación (Gmail)

#### Opción A: Gmail + App Password (Recomendado)

1. Activa la [Verificación en dos pasos](https://myaccount.google.com/security) en tu cuenta Gmail
2. Dirígete a [App passwords](https://myaccount.google.com/apppasswords)
3. Selecciona:
   - App: `Mail`
   - Device: `Windows Computer` (u otro)
4. Copia la contraseña generada → `GMAIL_APP_PASSWORD`
5. Tu email → `NOTIFICATION_EMAIL`

#### Opción B: Gmail Password directo (No recomendado)

Si usas contraseña directa:
- `GMAIL_APP_PASSWORD` = Tu contraseña de Gmail
- `NOTIFICATION_EMAIL` = Tu email de Gmail

### 5. Agregar secretos a GitHub

1. Ve a tu repositorio en GitHub
2. **Settings** → **Secrets and variables** → **Actions**
3. Haz clic en "New repository secret"
4. Agrega los siguientes secretos:

| Nombre | Valor | Fuente |
|--------|-------|--------|
| `SUPABASE_URL` | `https://xxxxxx.supabase.co` | Supabase Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGc...` | Supabase Settings → API |
| `GOOGLE_DRIVE_FOLDER_ID` | `1a2b3c4d...` | Google Drive URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account"...}` | Google Cloud Console (archivo JSON) |
| `NOTIFICATION_EMAIL` | `tu.email@gmail.com` | Tu email |
| `GMAIL_APP_PASSWORD` | `xxxx xxxx xxxx xxxx` | Google Account → App passwords |

⚠️ **IMPORTANTE**: 
- Nunca hagas commit de estos secretos
- Revisa que estén bien formateados (especialmente el JSON de Google)
- El JSON debe ser en una línea o usar escape correcto

## 📅 Cómo funciona

### Schedule
- **Ejecución**: Todos los días a las **8:00 AM UTC**
- **Trigger manual**: Puedes ejecutar manualmente desde Actions
- **Timeout**: 30 minutos por intento

### Flujo de reintentos

```
INTENTO 1 (backup job)
    ↓ (si falla, espera 5 minutos)
INTENTO 2 (retry-backup-1)
    ↓ (si falla, espera 5 minutos)
INTENTO 3 (retry-backup-2)
    ↓ (si falla)
NOTIFICACIÓN DE ESCALADA 🚨
```

### Qué se respalda

**Base de datos** (todas las tablas):
- `orders`, `users`, `drivers`, `clientes`, `transport_orders`
- `transport_order_stops`, `transport_units`, `transport_rates`
- `order_events`, `proof_of_delivery`, `ratings`, `driver_locations`
- `shipment_statuses`, `cliente_direcciones`, `cliente_contactos`, `cliente_documentos`

**Storage** (manifiestos):
- Lista de archivos en bucket `clientes-docs`
- Los archivos mismos NO se respaldan (solo inventario)

**Retención**:
- Se mantienen los últimos 30 días
- Los backups más antiguos se eliminan automáticamente

### Notificaciones

Recibirás emails en `NOTIFICATION_EMAIL`:

| Evento | Asunto | Contenido |
|--------|--------|----------|
| ✅ Éxito (intento 1) | `✅ ABZEND Backup exitoso - 2026-06-03` | Fecha, archivos, estado |
| ❌ Fallo (intento 1) | `❌ ABZEND Backup FALLIDO (intento 1/3)` | Se reintentará en 5 minutos |
| ✅ Éxito (reintento) | `✅ ABZEND Backup exitoso (reintento N)` | Detalles del backup |
| 🚨 Fallo final | `🚨 ABZEND Backup FALLIDO - 3 intentos sin éxito` | Link a logs, requiere revisión manual |

## 🧪 Pruebas

### Ejecutar backup manualmente

1. Ve a **Actions** en tu repositorio GitHub
2. Selecciona **ABZEND Daily Backup**
3. Haz clic en **Run workflow**
4. Espera a que termine (5-10 minutos)
5. Revisa los logs para detalle

### Verificar logs

1. En **Actions**, entra al workflow que se ejecutó
2. Haz clic en el job `backup` (o el retry correspondiente)
3. Expande **Run backup** para ver detalles

### Verificar archivos en Google Drive

1. Abre Google Drive
2. Ve a carpeta `ABZEND-Backups`
3. Deberías ver carpetas con fechas: `2026-06-03`, `2026-06-02`, etc.
4. Cada carpeta contiene:
   - `database_*.json` (tablas en JSON)
   - `database__resumen.txt` (resumen con conteos)
   - `storage_clientes-docs-manifest.json` (inventario de archivos)

## 🛠️ Troubleshooting

### Error: "404 Not Found" en tablas de Supabase

**Causa**: Service Role Key inválida o incorrecta

**Solución**:
```bash
# Verifica que el secret esté correcto:
# Settings → Secrets → SUPABASE_SERVICE_ROLE_KEY
# Debe empezar con 'eyJ...'
```

### Error: "Permission denied" en Google Drive

**Causa**: Service account no tiene permiso, o carpeta no está compartida

**Solución**:
1. Abre Google Drive
2. Comparte la carpeta `ABZEND-Backups`
3. Obtén el email de la service account (archivo JSON → `client_email`)
4. Dale acceso de Editor a esa carpeta

### Error: "Invalid JSON" en GOOGLE_SERVICE_ACCOUNT_JSON

**Causa**: El JSON está mal formateado o tiene saltos de línea

**Solución**:
```bash
# Descarga el JSON de Google Cloud
# Abre en editor de texto y cópialo COMPLETO
# Pégalo en el secret sin tocar nada
# GitHub lo escapará automáticamente
```

### Emails no llegan

**Causa**: Credenciales de Gmail incorrectas

**Solución**:
1. Verifica que usaste **App Password** (no la contraseña normal)
2. Si usas 2FA, asegúrate de estar usando App Password
3. Revisa **Actividad de tu cuenta** en Google para intentos fallidos

### Los backups son muy antiguos

**Causa**: Workflow no se ejecutó o falló silenciosamente

**Solución**:
1. Ve a **Actions** → **ABZEND Daily Backup**
2. Busca ejecuciones recientes
3. Si no hay nada, comprueba que el workflow está activo (no disabled)
4. Ejecuta manualmente para probar

## 📊 Monitoreo

### Dashboard recomendado

Revisa regularmente:
1. **GitHub Actions**: Última ejecución exitosa
2. **Google Drive**: Carpetas recientes (debería haber una diaria)
3. **Email**: Notificaciones de fallos (si recibiste 🚨, actúa)

### Alertas automáticas

Implementadas:
- ✅ Notificación al éxito (confirmación)
- ❌ Notificación en reintentos (información)
- 🚨 Escalada tras 3 fallos (requiere acción)

## 🔒 Seguridad

### Mejores prácticas implementadas

- ✅ Credenciales en GitHub Secrets (nunca en código)
- ✅ Service Account JSON en variable, no en archivo
- ✅ Cleanup automático de credenciales después de uso
- ✅ Carpeta Google Drive protegida con acceso limitado
- ✅ Backups retenidos solo 30 días (cumplimiento GDPR)
- ✅ Service Role Key de Supabase (no contraseña de usuario)

### Rotación de secretos

Cada 90 días, considera:
1. Regenerar **SUPABASE_SERVICE_ROLE_KEY** en Supabase
2. Rotar **GOOGLE_SERVICE_ACCOUNT_JSON** (crear nueva key)
3. Cambiar **GMAIL_APP_PASSWORD** (generar nueva)

## 📝 Estructura de archivos

```
abzend-backend/
├── .github/
│   ├── workflows/
│   │   └── backup.yml                    ← Workflow principal
│   ├── actions/
│   │   └── backup-action/
│   │       └── action.yml                ← Composite action reutilizable
│   ├── scripts/
│   │   └── backup.js                     ← Script de backup
│   └── BACKUP-SETUP.md                   ← Esta documentación
```

## 🚀 Próximos pasos

1. ✅ Agrega todos los secretos a GitHub
2. ✅ Ejecuta manualmente el workflow desde Actions
3. ✅ Verifica logs y notificación de email
4. ✅ Confirma archivos en Google Drive
5. ✅ Deja que el cron se ejecute automáticamente

## 📞 Soporte

Si algo falla:
1. Revisa los logs en **GitHub Actions**
2. Busca en la sección **Troubleshooting** de arriba
3. Verifica que todos los secretos están configurados
4. Ejecuta manualmente para diagnóstico

---

**Última actualización**: 2026-06-03  
**Versión**: 1.0 (Refactor con Composite Action)

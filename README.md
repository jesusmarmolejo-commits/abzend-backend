# ABZEND — Backend API
> Node.js + Express + Supabase + Stripe

---

## Estructura del proyecto

```
abzend-backend/
├── .env.example                        ← Variables de entorno (copia como .env)
├── package.json
├── supabase/
│   └── migrations/
│       └── 001_schema.sql              ← ⭐ Ejecuta esto en Supabase primero
└── src/
    ├── index.js                        ← Servidor Express + Realtime
    ├── routes/index.js                 ← Todas las rutas de la API
    ├── middleware/auth.js              ← JWT + control de roles
    ├── services/supabase.js            ← Clientes de Supabase
    └── controllers/
        ├── authController.js           ← Login / Registro
        ├── ordersController.js         ← CRUD órdenes + QR
        ├── driversController.js        ← Repartidores + GPS
        └── paymentsController.js       ← Stripe pagos
```

---

## Configuración paso a paso

### Paso 1 — Crear proyecto en Supabase (gratis)

1. Ve a https://app.supabase.com y crea una cuenta
2. Crea un nuevo proyecto (ej. "abzend-prod")
3. Espera ~2 minutos a que se inicialice
4. Ve a **Settings → API** y copia:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ nunca lo expongas

### Paso 2 — Ejecutar el esquema SQL

1. En Supabase, ve a **SQL Editor**
2. Abre el archivo `supabase/migrations/001_schema.sql`
3. Pega todo el contenido y presiona **Run**
4. Esto crea todas las tablas, índices, triggers y políticas de seguridad

### Paso 3 — Activar Realtime

1. En Supabase, ve a **Database → Replication**
2. Activa las tablas: `orders`, `driver_locations`, `order_events`

### Paso 4 — Configurar Stripe

1. Ve a https://dashboard.stripe.com
2. Activa México como país de pago
3. Copia tu `Secret Key` → `STRIPE_SECRET_KEY`
4. Para webhooks en desarrollo: `stripe listen --forward-to localhost:3000/v1/payments/webhook`

### Paso 5 — Configurar variables de entorno

```bash
cp .env.example .env
# Edita .env con tus credenciales reales
```

### Paso 6 — Instalar y correr

```bash
npm install
npm run dev     # Desarrollo con hot-reload
npm start       # Producción
```

---

## Endpoints de la API

### Autenticación
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/v1/auth/login` | Login (cliente, repartidor o admin) |
| POST | `/v1/auth/register` | Crear usuario (solo admins) |

### Órdenes
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/v1/orders` | Listar órdenes |
| POST | `/v1/orders` | Crear nueva orden |
| GET | `/v1/orders/:id` | Detalle de orden |
| GET | `/v1/orders/qr/:code` | Buscar por código QR |
| PATCH | `/v1/orders/:id/status` | Actualizar estado |
| POST | `/v1/orders/:id/pickup` | Confirmar recolección |
| POST | `/v1/admin/orders/:id/assign` | Asignar repartidor |

### Repartidor
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/v1/driver/orders` | Mis órdenes asignadas |
| GET | `/v1/driver/history` | Historial de entregas |
| PATCH | `/v1/driver/status` | Online / Offline |
| POST | `/v1/driver/location` | Actualizar GPS |

### Pagos
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/v1/payments/intent` | Crear intento de pago |
| POST | `/v1/payments/webhook` | Webhook de Stripe |
| GET | `/v1/payments/order/:id` | Estado del pago |

---

## Realtime con Supabase

El cliente puede suscribirse a cambios en tiempo real directamente desde el navegador o la app:

```js
// En el panel de cliente — rastrear su orden
const channel = supabase
  .channel('my-order')
  .on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'orders',
    filter: `id=eq.${orderId}`
  }, (payload) => {
    console.log('Nuevo estado:', payload.new.status);
  })
  .subscribe();
```

```js
// En el panel admin — ver repartidores en el mapa
const channel = supabase
  .channel('live-map')
  .on('postgres_changes', {
    event: 'INSERT', schema: 'public', table: 'driver_locations'
  }, (payload) => {
    updateMapPin(payload.new.driver_id, payload.new.lat, payload.new.lng);
  })
  .subscribe();
```

---

## Despliegue en producción

### Opción A — Railway (recomendado, $5/mes)
```bash
# Instala Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
# Railway detecta automáticamente Node.js
```

### Opción B — Render (gratis con limitaciones)
1. Conecta tu repo en https://render.com
2. Build command: `npm install`
3. Start command: `npm start`
4. Agrega las variables de entorno en el dashboard

### Opción C — VPS (DigitalOcean, Hetzner)
```bash
# En el servidor
git clone tu-repo && cd abzend-backend
npm install
npm install -g pm2
pm2 start src/index.js --name abzend-api
pm2 save && pm2 startup
```

---

## Conexión con los paneles web

Una vez desplegado, actualiza la URL en los 3 proyectos:

**Panel Cliente / Admin (web):**
```js
const BASE_URL = 'https://tu-backend.railway.app/v1';
```

**App Repartidor (React Native):**
```js
// src/services/api.js
const BASE_URL = 'https://tu-backend.railway.app/v1';
```

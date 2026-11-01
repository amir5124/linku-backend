// modules/order/order-notification.copy.ts
// Teks notifikasi order yang disesuaikan dengan layanan: ride, send (kirim paket), food (pesan makanan).
// Semua fungsi murni (tanpa akses database), hanya menghasilkan { title, body }.

export type OrderKind = 'ride' | 'send' | 'food' | 'jastip';

/** order.type → jenis layanan. Selain food/send/jastip dianggap ride. */
export const kindOf = (type?: string | null): OrderKind =>
    type === 'food'
        ? 'food'
        : type === 'send'
            ? 'send'
            : type === 'jastip'
                ? 'jastip'
                : 'ride';

export type Copy = { title: string; body: string };

const vehicleText = (vehicle?: string | null, plate?: string | null) => {
    const v = (vehicle ?? '').trim();
    const p = (plate ?? '').trim();
    return v && p ? `${v} ${p}` : v || p;
};

// ============================================================
// 1) Order baru untuk DRIVER (broadcast / autobid)
// ============================================================
export function newOrderForDriver(p: {
    kind: OrderKind;
    pickup: string;
    dropoff: string;
    jarak: string; // mis. "3.2 km"
    fare: string; // mis. "Rp12.000"
    itemCount?: number; // khusus food
    autobid?: boolean;
}): Copy {
    const tail = `${p.jarak} · ${p.fare}`;

    if (p.kind === 'send') {
        return {
            title: p.autobid ? '📦 Kamu dapat antar paket (Autobid)' : 'Antar paket baru 📦',
            body: `Ambil di ${p.pickup} → ${p.dropoff} · ${tail}`,
        };
    }

    if (p.kind === 'jastip') {
        const items = p.itemCount && p.itemCount > 0 ? ` (${p.itemCount} barang)` : '';
        return {
            title: p.autobid ? '🛍️ Kamu dapat jastip (Autobid)' : 'Jastip baru 🛍️',
            body: `Belanja di ${p.pickup}${items} → ${p.dropoff} · ${tail}`,
        };
    }

    if (p.kind === 'food') {
        const items = p.itemCount && p.itemCount > 0 ? ` (${p.itemCount} item)` : '';
        return {
            title: p.autobid ? '🍔 Kamu dapat pesanan makanan (Autobid)' : 'Pesanan makanan baru 🍔',
            body: `Beli di ${p.pickup}${items} → ${p.dropoff} · ${tail}`,
        };
    }

    return {
        title: p.autobid ? '🚀 Kamu dapat penumpang (Autobid)' : 'Penumpang baru masuk 🚀',
        body: `${p.pickup} → ${p.dropoff} · ${tail}`,
    };
}

// ============================================================
// 2) Driver sudah dapat → untuk CUSTOMER
//    driverName/vehicle/plate opsional (autobid saat create belum punya datanya)
// ============================================================
export function driverFoundForCustomer(p: {
    kind: OrderKind;
    pickup?: string;
    driverName?: string | null;
    vehicle?: string | null;
    plate?: string | null;
}): Copy {
    const veh = vehicleText(p.vehicle, p.plate);
    const name = p.driverName?.trim();
    const who = name ? (veh ? `${name} (${veh})` : name) : 'Driver';

    if (p.kind === 'send') {
        return {
            title: 'Driver pengantar paket sudah dapat! 📦',
            body: `${who} sedang menuju ${p.pickup ?? 'lokasimu'} untuk mengambil paketmu`,
        };
    }

    if (p.kind === 'jastip') {
        return {
            title: 'Driver jastip sudah dapat! 🛍️',
            body: `${who} akan membelikan titipanmu di ${p.pickup ?? 'toko'}`,
        };
    }

    if (p.kind === 'food') {
        return {
            title: 'Drivermu sudah dapat! 🍜',
            body: `${who} akan membeli pesananmu di ${p.pickup ?? 'resto'}`,
        };
    }

    return {
        title: 'Drivermu sudah dapat! 🎉',
        body: `${who} sedang menuju ke lokasimu`,
    };
}

// ============================================================
// 3) Belum ada driver → untuk CUSTOMER
// ============================================================
export function searchingForCustomer(kind: OrderKind): Copy {
    if (kind === 'send') {
        return {
            title: 'Mencari driver…',
            body: 'Kami sedang mencarikan driver untuk mengantar paketmu. Mohon tunggu.',
        };
    }
    if (kind === 'jastip') {
        return {
            title: 'Mencari driver…',
            body: 'Kami sedang mencarikan driver untuk membelikan titipanmu. Mohon tunggu.',
        };
    }
    if (kind === 'food') {
        return {
            title: 'Mencari driver…',
            body: 'Kami sedang mencarikan driver untuk membeli pesananmu. Mohon tunggu.',
        };
    }
    return {
        title: 'Mencari driver…',
        body: 'Kami sedang mencarikan driver untukmu. Mohon tunggu.',
    };
}

// ============================================================
// 4) Perubahan status (arrived / in_progress / completed / cancelled)
// ============================================================
export type StatusParams = {
    kind: OrderKind;
    status: string;
    /** siapa yang menerima notifikasi ini */
    target: 'customer' | 'driver' | 'merchant';
    /** siapa yang mengubah status */
    senderIsDriver: boolean;
    senderIsCustomer: boolean;
    senderName: string; // nama depan pengubah status
    customerName: string; // nama depan customer
    pickup: string;
    dropoff: string;
    reason?: string | null;
};

export function statusNotif(p: StatusParams): Copy {
    const { kind, status, target, senderIsDriver, senderIsCustomer, senderName: who } = p;
    const { customerName, pickup, dropoff, reason } = p;
    const toCustomer = target === 'customer';
    const toDriver = target === 'driver';
    const toMerchant = target === 'merchant';

    // ---------------- purchasing (khusus jastip) ----------------
    if (status === 'purchasing') {
        if (toCustomer) {
            return { title: 'Driver mulai berbelanja 🛒', body: `${who} sedang membelikan titipanmu di ${pickup}` };
        }
        if (toDriver) return { title: 'Mulai belanja', body: 'Beli semua barang lalu unggah foto struk' };
        return { title: 'Driver sedang berbelanja', body: `${who} sedang berbelanja` };
    }

    // ---------------- arrived ----------------
    if (status === 'arrived') {
        if (kind === 'jastip') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Driver sudah di toko 📍', body: `${who} sudah tiba di ${pickup} dan siap berbelanja` };
            }
            if (toDriver) return { title: 'Kamu sudah di toko', body: `Mulai belanja titipan di ${pickup}` };
            return { title: 'Driver sudah tiba', body: `${who} sudah di ${pickup}` };
        }
        if (kind === 'food') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Driver sudah di resto 🍽️', body: `${who} sudah tiba di ${pickup} dan mengambil pesananmu` };
            }
            if (toDriver) return { title: 'Kamu sudah di resto', body: `Ambil pesanan customer di ${pickup}` };
            if (toMerchant) return { title: 'Driver sudah di tokomu', body: `${who} siap mengambil pesanan` };
            return { title: 'Driver sudah tiba', body: `${who} sudah di ${pickup}` };
        }
        if (kind === 'send') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Driver sudah tiba 📍', body: `${who} sudah di ${pickup} untuk mengambil paketmu. Siapkan paketnya ya!` };
            }
            if (toDriver) return { title: 'Kamu sudah di lokasi pengirim', body: `Ambil paket di ${pickup}` };
            return { title: 'Driver sudah tiba', body: `${who} sudah di ${pickup} untuk mengambil paket` };
        }
        // ride
        if (toCustomer && senderIsDriver) {
            return { title: 'Driver sudah tiba 📍', body: `${who} sudah menunggu di ${pickup}. Siap-siap ya!` };
        }
        if (toDriver) return { title: 'Kamu sudah di titik jemput', body: `Tunggu customer di ${pickup} ya` };
        return { title: 'Driver sudah tiba', body: `${who} sudah di ${pickup}` };
    }

    // ---------------- in_progress ----------------
    if (status === 'in_progress') {
        if (kind === 'jastip') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Belanjaanmu sedang diantar 🛵', body: `${who} menuju ${dropoff}. Siap-siap menerima ya!` };
            }
            if (toDriver) return { title: 'Antar belanjaan', body: `Antar belanjaan ke ${dropoff}` };
            return { title: 'Belanjaan dalam perjalanan', body: `Menuju ${dropoff}` };
        }
        if (kind === 'food') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Pesananmu sedang diantar 🛵', body: `${who} menuju ${dropoff}. Siap-siap menerima ya!` };
            }
            if (toDriver) return { title: 'Antar pesanan', body: `Antar pesanan ke ${dropoff}` };
            if (toMerchant) return { title: 'Pesanan diambil driver', body: `${who} sedang mengantar pesanan` };
            return { title: 'Pesanan dalam perjalanan', body: `Menuju ${dropoff}` };
        }
        if (kind === 'send') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Paketmu sedang diantar 📦', body: `${who} membawa paketmu ke ${dropoff}` };
            }
            if (toDriver) return { title: 'Pengantaran dimulai', body: `Antar paket ke ${dropoff}` };
            return { title: 'Paket dalam perjalanan', body: `Menuju ${dropoff}` };
        }
        // ride
        if (toCustomer && senderIsDriver) {
            return { title: 'Perjalanan dimulai 🚗', body: `Menuju ${dropoff}. Hati-hati di jalan!` };
        }
        if (toDriver) return { title: 'Perjalanan dimulai', body: `Antar customer ke ${dropoff}` };
        return { title: 'Dalam perjalanan', body: `Menuju ${dropoff}` };
    }

    // ---------------- completed ----------------
    if (status === 'completed') {
        if (kind === 'jastip') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Belanjaan tiba! 🛍️', body: `Titipanmu sudah sampai. Jangan lupa beri rating untuk ${who} ya!` };
            }
            if (toDriver) return { title: 'Jastip selesai 🎯', body: 'Belanjaan terantar. Kamu kembali online sekarang.' };
            return { title: 'Jastip selesai', body: `Sampai di ${dropoff}` };
        }
        if (kind === 'food') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Pesanan tiba! 🍽️', body: `Selamat menikmati makananmu. Jangan lupa beri rating untuk ${who} ya!` };
            }
            if (toDriver) return { title: 'Pesanan selesai 🎯', body: 'Pesanan sudah diantar. Kamu kembali online sekarang.' };
            if (toMerchant) return { title: 'Pesanan selesai', body: 'Pesanan sudah diterima customer' };
            return { title: 'Pesanan selesai', body: `Sampai di ${dropoff}` };
        }
        if (kind === 'send') {
            if (toCustomer && senderIsDriver) {
                return { title: 'Paket terkirim ✅', body: `Paketmu sudah sampai di ${dropoff}. Jangan lupa beri rating untuk ${who} ya!` };
            }
            if (toDriver) return { title: 'Pengantaran selesai 🎯', body: 'Paket terkirim. Kamu kembali online sekarang.' };
            return { title: 'Paket terkirim', body: `Sampai di ${dropoff}` };
        }
        // ride
        if (toCustomer && senderIsDriver) {
            return {
                title: 'Sudah sampai tujuan ✨',
                body: `Terima kasih sudah pakai LinkU. Jangan lupa beri rating untuk ${who} ya!`,
            };
        }
        if (toDriver) return { title: 'Perjalanan selesai 🎯', body: 'Order selesai. Kamu kembali online sekarang.' };
        return { title: 'Perjalanan selesai', body: `Sampai di ${dropoff}` };
    }

    // ---------------- cancelled ----------------
    if (status === 'cancelled') {
        const noun =
            kind === 'send' ? 'Pengiriman' : kind === 'food' || kind === 'jastip' ? 'Pesanan' : 'Perjalanan';
        if (toCustomer) {
            return {
                title: `${noun} dibatalkan`,
                body: reason ?? (senderIsDriver ? `${noun} dibatalkan oleh ${who}` : `${noun} dibatalkan`),
            };
        }
        if (toDriver) {
            return {
                title: `${noun} dibatalkan ⚠️`,
                body: senderIsCustomer ? `Orderan dibatalkan oleh ${customerName}` : reason ?? `${noun} dibatalkan`,
            };
        }
        return { title: `${noun} dibatalkan`, body: reason ?? `${noun} dibatalkan` };
    }

    return { title: 'Update pesanan', body: `Status: ${status}` };
}
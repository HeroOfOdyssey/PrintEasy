#include <ctype.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/cyw43_arch.h"
#include "pico/unique_id.h"

#include "lwip/apps/mqtt.h"
#include "lwip/dns.h"
#include "lwip/ip_addr.h"

#if PRINTEASY_TRANSPORT_SERIAL
#include "hardware/uart.h"
#endif

#if PRINTEASY_TRANSPORT_USB
#include "pico/stdio_usb.h"
#endif

#if PRINTEASY_TRANSPORT_BLUETOOTH
#include "btstack.h"
#endif

#define MQTT_KEEP_ALIVE_S 60
#define MQTT_QOS 1
#define MQTT_TOPIC_MAX 128
#define WIFI_CONNECT_TIMEOUT_MS 30000
#define MQTT_RECONNECT_DELAY_MS 5000

#ifndef PRINTEASY_BUFFER_SIZE
#define PRINTEASY_BUFFER_SIZE 32768
#endif

#if PRINTEASY_TRANSPORT_USB
#define PE_LOG(...) do { } while (0)
#else
#define PE_LOG(...) printf(__VA_ARGS__)
#endif

typedef struct {
    mqtt_client_t *client;
    struct mqtt_connect_client_info_t info;
    ip_addr_t server_addr;
    char topic[MQTT_TOPIC_MAX];
    bool incoming_print_job;
    bool connected_once;
} printeasy_mqtt_t;

static printeasy_mqtt_t mqtt_state;

#if PRINTEASY_TRANSPORT_BLUETOOTH
static btstack_timer_source_t mqtt_reconnect_timer;
#endif

#if PRINTEASY_TRANSPORT_BLUETOOTH || PRINTEASY_TRANSPORT_USB
static uint8_t printer_buffer[PRINTEASY_BUFFER_SIZE];
static size_t printer_read_pos;
static size_t printer_write_pos;
static size_t printer_used;
static bool printer_overflowed;

static size_t buffer_write(const uint8_t *data, size_t len) {
    size_t accepted = 0;
    while (accepted < len && printer_used < sizeof(printer_buffer)) {
        printer_buffer[printer_write_pos] = data[accepted++];
        printer_write_pos = (printer_write_pos + 1) % sizeof(printer_buffer);
        printer_used++;
    }
    if (accepted < len) {
        printer_overflowed = true;
    }
    return accepted;
}

static size_t buffer_contiguous_read(const uint8_t **ptr) {
    if (printer_used == 0) {
        *ptr = NULL;
        return 0;
    }
    *ptr = &printer_buffer[printer_read_pos];
    size_t end_room = sizeof(printer_buffer) - printer_read_pos;
    return printer_used < end_room ? printer_used : end_room;
}

static void buffer_consume(size_t len) {
    if (len > printer_used) {
        len = printer_used;
    }
    printer_read_pos = (printer_read_pos + len) % sizeof(printer_buffer);
    printer_used -= len;
}
#endif

#if PRINTEASY_TRANSPORT_BLUETOOTH
static bd_addr_t printer_addr;
static uint8_t rfcomm_channel;
static uint16_t rfcomm_cid;
static uint16_t rfcomm_mtu = 127;
static bool rfcomm_send_pending;
static btstack_packet_callback_registration_t hci_event_registration;
static btstack_context_callback_registration_t sdp_query_registration;

static void bt_packet_handler(uint8_t packet_type, uint16_t channel, uint8_t *packet, uint16_t size);

static void request_bt_send(void) {
    if (rfcomm_cid && !rfcomm_send_pending && printer_used > 0) {
        rfcomm_send_pending = true;
        rfcomm_request_can_send_now_event(rfcomm_cid);
    }
}

static void bt_send_available(void) {
    rfcomm_send_pending = false;
    const uint8_t *ptr = NULL;
    size_t len = buffer_contiguous_read(&ptr);
    if (!ptr || len == 0 || !rfcomm_cid) {
        return;
    }
    if (len > rfcomm_mtu) {
        len = rfcomm_mtu;
    }
    int err = rfcomm_send(rfcomm_cid, (uint8_t *)ptr, (uint16_t)len);
    if (err == ERROR_CODE_SUCCESS) {
        buffer_consume(len);
    } else {
        PE_LOG("Bluetooth write failed: 0x%02x\n", err);
    }
    request_bt_send();
}

static void sdp_query_handler(uint8_t packet_type, uint16_t channel, uint8_t *packet, uint16_t size) {
    (void)packet_type;
    (void)channel;
    (void)size;

    switch (hci_event_packet_get_type(packet)) {
        case SDP_EVENT_QUERY_RFCOMM_SERVICE:
            rfcomm_channel = sdp_event_query_rfcomm_service_get_rfcomm_channel(packet);
            break;
        case SDP_EVENT_QUERY_COMPLETE:
            if (sdp_event_query_complete_get_status(packet)) {
                PE_LOG("Bluetooth SDP query failed: 0x%02x\n", sdp_event_query_complete_get_status(packet));
                break;
            }
            if (!rfcomm_channel) {
                PE_LOG("Bluetooth printer has no Serial Port Profile service\n");
                break;
            }
            PE_LOG("Connecting RFCOMM channel %u on %s\n", rfcomm_channel, bd_addr_to_str(printer_addr));
            rfcomm_create_channel(bt_packet_handler, printer_addr, rfcomm_channel, NULL);
            break;
        default:
            break;
    }
}

static void start_sdp_query(void *context) {
    (void)context;
    sdp_client_query_rfcomm_channel_and_name_for_uuid(&sdp_query_handler, printer_addr, BLUETOOTH_SERVICE_CLASS_SERIAL_PORT);
}

static void connect_bluetooth_printer(void) {
    if (PRINTER_BT_CHANNEL > 0) {
        rfcomm_channel = (uint8_t)PRINTER_BT_CHANNEL;
        PE_LOG("Connecting RFCOMM channel %u on %s\n", rfcomm_channel, bd_addr_to_str(printer_addr));
        rfcomm_create_channel(bt_packet_handler, printer_addr, rfcomm_channel, NULL);
        return;
    }

    PE_LOG("Querying SPP channel on %s\n", bd_addr_to_str(printer_addr));
    sdp_query_registration.callback = &start_sdp_query;
    (void)sdp_client_register_query_callback(&sdp_query_registration);
}

static void bt_packet_handler(uint8_t packet_type, uint16_t channel, uint8_t *packet, uint16_t size) {
    (void)channel;
    (void)size;

    bd_addr_t event_addr;

    if (packet_type == RFCOMM_DATA_PACKET) {
        return;
    }
    if (packet_type != HCI_EVENT_PACKET) {
        return;
    }

    switch (hci_event_packet_get_type(packet)) {
        case BTSTACK_EVENT_STATE:
            if (btstack_event_state_get_state(packet) == HCI_STATE_WORKING) {
                connect_bluetooth_printer();
            }
            break;
        case HCI_EVENT_PIN_CODE_REQUEST:
            hci_event_pin_code_request_get_bd_addr(packet, event_addr);
            PE_LOG("Bluetooth PIN requested, using configured PIN\n");
            gap_pin_code_response(event_addr, PRINTER_BT_PIN);
            break;
        case HCI_EVENT_USER_CONFIRMATION_REQUEST:
            PE_LOG("Bluetooth user confirmation requested; auto-accepting\n");
            break;
        case RFCOMM_EVENT_CHANNEL_OPENED:
            if (rfcomm_event_channel_opened_get_status(packet)) {
                PE_LOG("RFCOMM open failed: 0x%02x\n", rfcomm_event_channel_opened_get_status(packet));
                rfcomm_cid = 0;
                break;
            }
            rfcomm_cid = rfcomm_event_channel_opened_get_rfcomm_cid(packet);
            rfcomm_mtu = rfcomm_event_channel_opened_get_max_frame_size(packet);
            PE_LOG("RFCOMM connected, cid 0x%04x, mtu %u\n", rfcomm_cid, rfcomm_mtu);
            request_bt_send();
            break;
        case RFCOMM_EVENT_CAN_SEND_NOW:
            bt_send_available();
            break;
        case RFCOMM_EVENT_CHANNEL_CLOSED:
            PE_LOG("RFCOMM closed\n");
            rfcomm_cid = 0;
            rfcomm_send_pending = false;
            sleep_ms(1000);
            connect_bluetooth_printer();
            break;
        default:
            break;
    }
}

static void printer_transport_init(void) {
    if (!sscanf_bd_addr(PRINTER_BT_ADDR, printer_addr)) {
        panic("Set PRINTER_BT_ADDR to the Bluetooth printer MAC address");
    }

    l2cap_init();
    rfcomm_init();
    gap_ssp_set_io_capability(SSP_IO_CAPABILITY_NO_INPUT_NO_OUTPUT);

    hci_event_registration.callback = &bt_packet_handler;
    hci_add_event_handler(&hci_event_registration);
    hci_power_control(HCI_POWER_ON);
}

static void printer_write(const uint8_t *data, size_t len) {
    size_t accepted = buffer_write(data, len);
    if (accepted != len && printer_overflowed) {
        PE_LOG("Printer buffer full; dropped %u bytes\n", (unsigned)(len - accepted));
        printer_overflowed = false;
    }
    request_bt_send();
}
#endif

#if PRINTEASY_TRANSPORT_SERIAL
static uart_inst_t *printer_uart(void) {
    return PRINTER_UART_ID == 1 ? uart1 : uart0;
}

static void printer_transport_init(void) {
    uart_inst_t *uart = printer_uart();
    uart_init(uart, PRINTER_BAUD);
    gpio_set_function(PRINTER_UART_TX_PIN, GPIO_FUNC_UART);
    gpio_set_function(PRINTER_UART_RX_PIN, GPIO_FUNC_UART);
    PE_LOG("Serial printer on uart%u tx=%u rx=%u baud=%u\n",
           PRINTER_UART_ID, PRINTER_UART_TX_PIN, PRINTER_UART_RX_PIN, PRINTER_BAUD);
}

static void printer_write(const uint8_t *data, size_t len) {
    uart_write_blocking(printer_uart(), data, len);
}
#endif

#if PRINTEASY_TRANSPORT_USB
static void printer_transport_init(void) {
    stdio_usb_init();
    absolute_time_t deadline = make_timeout_time_ms(3000);
    while (!stdio_usb_connected() && absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
        sleep_ms(50);
    }
}

static void flush_usb_buffer(void) {
    const uint8_t *ptr = NULL;
    size_t len = buffer_contiguous_read(&ptr);
    while (ptr && len > 0 && stdio_usb_connected()) {
        size_t written = fwrite(ptr, 1, len, stdout);
        fflush(stdout);
        if (written == 0) {
            break;
        }
        buffer_consume(written);
        len = buffer_contiguous_read(&ptr);
    }
}

static void printer_write(const uint8_t *data, size_t len) {
    size_t accepted = buffer_write(data, len);
    if (accepted != len) {
        printer_overflowed = true;
    }
    flush_usb_buffer();
}
#endif

static void mqtt_subscribe_request_cb(void *arg, err_t result) {
    (void)arg;
    PE_LOG("MQTT subscribe result: %d\n", result);
}

static void mqtt_incoming_publish_cb(void *arg, const char *topic, u32_t total_len) {
    printeasy_mqtt_t *state = (printeasy_mqtt_t *)arg;
    (void)total_len;
    snprintf(state->topic, sizeof(state->topic), "%s", topic);
    state->incoming_print_job = strcmp(topic, MQTT_TOPIC) == 0;
}

static void mqtt_incoming_data_cb(void *arg, const uint8_t *data, uint16_t len, uint8_t flags) {
    printeasy_mqtt_t *state = (printeasy_mqtt_t *)arg;
    (void)flags;

    if (!state->incoming_print_job) {
        return;
    }

    printer_write(data, len);
}

static void mqtt_connection_cb(mqtt_client_t *client, void *arg, mqtt_connection_status_t status) {
    printeasy_mqtt_t *state = (printeasy_mqtt_t *)arg;
    if (status == MQTT_CONNECT_ACCEPTED) {
        state->connected_once = true;
        PE_LOG("MQTT connected; subscribing to %s\n", MQTT_TOPIC);
        mqtt_subscribe(client, MQTT_TOPIC, MQTT_QOS, mqtt_subscribe_request_cb, state);
        return;
    }

    PE_LOG("MQTT disconnected/status %d\n", status);
}

static void mqtt_start(printeasy_mqtt_t *state) {
    if (!state->client) {
        state->client = mqtt_client_new();
        if (!state->client) {
            panic("Could not allocate MQTT client");
        }
        mqtt_set_inpub_callback(state->client, mqtt_incoming_publish_cb, mqtt_incoming_data_cb, state);
    }

    cyw43_arch_lwip_begin();
    err_t err = mqtt_client_connect(state->client, &state->server_addr, MQTT_PORT, mqtt_connection_cb, state, &state->info);
    cyw43_arch_lwip_end();
    if (err != ERR_OK) {
        PE_LOG("MQTT connect failed: %d\n", err);
    }
}

#if PRINTEASY_TRANSPORT_BLUETOOTH
static void mqtt_reconnect_timer_handler(btstack_timer_source_t *timer) {
    (void)timer;
    if (mqtt_state.client && mqtt_state.connected_once && !mqtt_client_is_connected(mqtt_state.client)) {
        mqtt_start(&mqtt_state);
    }
    request_bt_send();
    btstack_run_loop_set_timer(&mqtt_reconnect_timer, MQTT_RECONNECT_DELAY_MS);
    btstack_run_loop_add_timer(&mqtt_reconnect_timer);
}
#endif

static void dns_found_cb(const char *hostname, const ip_addr_t *ipaddr, void *arg) {
    printeasy_mqtt_t *state = (printeasy_mqtt_t *)arg;
    if (!ipaddr) {
        panic("DNS failed for MQTT server %s", hostname);
    }
    state->server_addr = *ipaddr;
    mqtt_start(state);
}

static void configure_mqtt_identity(printeasy_mqtt_t *state) {
    static char client_id[32];
    char unique_id[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
    pico_get_unique_board_id_string(unique_id, sizeof(unique_id));
    for (size_t i = 0; unique_id[i]; i++) {
        unique_id[i] = (char)tolower((unsigned char)unique_id[i]);
    }
    snprintf(client_id, sizeof(client_id), "printeasy-pico-%s", &unique_id[sizeof(unique_id) - 5]);

    state->info.client_id = client_id;
    state->info.keep_alive = MQTT_KEEP_ALIVE_S;
#if defined(MQTT_USERNAME) && defined(MQTT_PASSWORD)
    state->info.client_user = MQTT_USERNAME;
    state->info.client_pass = MQTT_PASSWORD;
#endif
}

static void connect_wifi(void) {
    if (cyw43_arch_init()) {
        panic("CYW43 init failed");
    }
    cyw43_arch_enable_sta_mode();
    PE_LOG("Connecting Wi-Fi SSID %s\n", WIFI_SSID);
    int err = cyw43_arch_wifi_connect_timeout_ms(WIFI_SSID, WIFI_PASSWORD, CYW43_AUTH_WPA2_AES_PSK, WIFI_CONNECT_TIMEOUT_MS);
    if (err) {
        panic("Wi-Fi connect failed: %d", err);
    }
    PE_LOG("Wi-Fi connected\n");
}

static void resolve_mqtt(printeasy_mqtt_t *state) {
    err_t err = dns_gethostbyname(MQTT_SERVER, &state->server_addr, dns_found_cb, state);
    if (err == ERR_OK) {
        mqtt_start(state);
    } else if (err != ERR_INPROGRESS) {
        panic("DNS request failed: %d", err);
    }
}

int main(void) {
    stdio_init_all();
    sleep_ms(1500);
    PE_LOG("PrintEasy Pico client starting\n");

    connect_wifi();
    printer_transport_init();
    configure_mqtt_identity(&mqtt_state);
    resolve_mqtt(&mqtt_state);

#if PRINTEASY_TRANSPORT_BLUETOOTH
    btstack_run_loop_set_timer_handler(&mqtt_reconnect_timer, mqtt_reconnect_timer_handler);
    btstack_run_loop_set_timer(&mqtt_reconnect_timer, MQTT_RECONNECT_DELAY_MS);
    btstack_run_loop_add_timer(&mqtt_reconnect_timer);
    btstack_run_loop_execute();
#else
    while (true) {
        if (mqtt_state.client && mqtt_state.connected_once && !mqtt_client_is_connected(mqtt_state.client)) {
            sleep_ms(MQTT_RECONNECT_DELAY_MS);
            mqtt_start(&mqtt_state);
        }
#if PRINTEASY_TRANSPORT_USB
        flush_usb_buffer();
#endif
        sleep_ms(50);
    }
#endif
}

cmake_minimum_required(VERSION 3.13)

if (DEFINED ENV{PICO_SDK_PATH} AND NOT PICO_SDK_PATH)
  set(PICO_SDK_PATH $ENV{PICO_SDK_PATH})
endif()

if (NOT PICO_SDK_PATH)
  message(FATAL_ERROR "Set PICO_SDK_PATH to the Raspberry Pi Pico SDK checkout")
endif()

if (NOT PICO_BOARD)
  set(PICO_BOARD pico_w CACHE STRING "Pico board target" FORCE)
endif()

include(${PICO_SDK_PATH}/external/pico_sdk_import.cmake)

project(printeasy_pico C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

set(WIFI_SSID "" CACHE STRING "Wi-Fi SSID")
set(WIFI_PASSWORD "" CACHE STRING "Wi-Fi password")
set(MQTT_SERVER "" CACHE STRING "MQTT broker hostname or IP")
set(MQTT_PORT "1883" CACHE STRING "MQTT broker port")
set(MQTT_TOPIC "receipt/print" CACHE STRING "PrintEasy MQTT topic")
set(MQTT_USERNAME "" CACHE STRING "Optional MQTT username")
set(MQTT_PASSWORD "" CACHE STRING "Optional MQTT password")
set(PRINTER_TRANSPORT "bluetooth" CACHE STRING "Printer transport: bluetooth, serial, or usb")
set(PRINTER_BT_ADDR "" CACHE STRING "Bluetooth printer MAC address, e.g. AA:BB:CC:DD:EE:FF")
set(PRINTER_BT_PIN "0000" CACHE STRING "Bluetooth pairing PIN")
set(PRINTER_BT_CHANNEL "0" CACHE STRING "RFCOMM channel; 0 queries SDP for Serial Port")
set(PRINTER_UART_ID "0" CACHE STRING "UART number for serial transport: 0 or 1")
set(PRINTER_UART_TX_PIN "0" CACHE STRING "GPIO TX pin for serial transport")
set(PRINTER_UART_RX_PIN "1" CACHE STRING "GPIO RX pin for serial transport")
set(PRINTER_BAUD "9600" CACHE STRING "Serial printer baud rate")
set(PRINTEASY_BUFFER_SIZE "32768" CACHE STRING "Buffered printer bytes for Bluetooth/USB backpressure")

if (NOT WIFI_SSID OR NOT WIFI_PASSWORD OR NOT MQTT_SERVER)
  message(FATAL_ERROR "Set WIFI_SSID, WIFI_PASSWORD, and MQTT_SERVER")
endif()

string(TOLOWER "${PRINTER_TRANSPORT}" PRINTER_TRANSPORT_LOWER)
if (NOT PRINTER_TRANSPORT_LOWER MATCHES "^(bluetooth|serial|usb)$")
  message(FATAL_ERROR "PRINTER_TRANSPORT must be bluetooth, serial, or usb")
endif()

add_executable(printeasy_pico
  src/printeasy_pico.c
)

target_include_directories(printeasy_pico PRIVATE
  ${CMAKE_CURRENT_LIST_DIR}/include
)

target_compile_definitions(printeasy_pico PRIVATE
  WIFI_SSID="${WIFI_SSID}"
  WIFI_PASSWORD="${WIFI_PASSWORD}"
  MQTT_SERVER="${MQTT_SERVER}"
  MQTT_PORT=${MQTT_PORT}
  MQTT_TOPIC="${MQTT_TOPIC}"
  PRINTER_BT_ADDR="${PRINTER_BT_ADDR}"
  PRINTER_BT_PIN="${PRINTER_BT_PIN}"
  PRINTER_BT_CHANNEL=${PRINTER_BT_CHANNEL}
  PRINTER_UART_ID=${PRINTER_UART_ID}
  PRINTER_UART_TX_PIN=${PRINTER_UART_TX_PIN}
  PRINTER_UART_RX_PIN=${PRINTER_UART_RX_PIN}
  PRINTER_BAUD=${PRINTER_BAUD}
  PRINTEASY_BUFFER_SIZE=${PRINTEASY_BUFFER_SIZE}
)

if (MQTT_USERNAME AND MQTT_PASSWORD)
  target_compile_definitions(printeasy_pico PRIVATE
    MQTT_USERNAME="${MQTT_USERNAME}"
    MQTT_PASSWORD="${MQTT_PASSWORD}"
  )
endif()

if (PRINTER_TRANSPORT_LOWER STREQUAL "bluetooth")
  target_compile_definitions(printeasy_pico PRIVATE PRINTEASY_TRANSPORT_BLUETOOTH=1)
  target_link_libraries(printeasy_pico
    pico_stdlib
    pico_cyw43_arch_lwip_threadsafe_background
    pico_lwip_mqtt
    pico_btstack_classic
  )
elseif (PRINTER_TRANSPORT_LOWER STREQUAL "serial")
  target_compile_definitions(printeasy_pico PRIVATE PRINTEASY_TRANSPORT_SERIAL=1)
  target_link_libraries(printeasy_pico
    pico_stdlib
    hardware_uart
    pico_cyw43_arch_lwip_threadsafe_background
    pico_lwip_mqtt
  )
elseif (PRINTER_TRANSPORT_LOWER STREQUAL "usb")
  target_compile_definitions(printeasy_pico PRIVATE PRINTEASY_TRANSPORT_USB=1)
  target_link_libraries(printeasy_pico
    pico_stdlib
    pico_stdio_usb
    pico_cyw43_arch_lwip_threadsafe_background
    pico_lwip_mqtt
  )
endif()

if (PRINTER_TRANSPORT_LOWER STREQUAL "usb")
  pico_enable_stdio_usb(printeasy_pico 1)
  pico_enable_stdio_uart(printeasy_pico 0)
else()
  pico_enable_stdio_usb(printeasy_pico 0)
  pico_enable_stdio_uart(printeasy_pico 1)
endif()

pico_add_extra_outputs(printeasy_pico)

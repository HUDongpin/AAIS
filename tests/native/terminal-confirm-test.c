#include "core.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static unsigned checks=0;
#define CHECK(x) do { assert(x); checks++; } while(0)
static ConfirmSession begin(void) {
    ConfirmSession s; ConfirmOperation op=confirm_fixture();
    assert(confirm_begin(&s,&op,"0123456789abcdef",1000)); return s;
}
int main(void) {
    const char *yes="CONFIRM AAIS 0123456789abcdef\n";
    ConfirmOperation op=confirm_fixture(); ConfirmSession s=begin();
    CHECK(!strcmp(confirm_finish(&s,&op,yes,strlen(yes),1001,true),"offline-operation-confirmed"));
    CHECK(s.state==CONFIRM_ACCEPTED);
    CHECK(!strcmp(confirm_finish(&s,&op,yes,strlen(yes),1002,true),"already-finished"));
    const char *wrong[]={"\n","yes\n","CONFIRM AAIS\n","CONFIRM AAIS fedcba9876543210\n",
        " CONFIRM AAIS 0123456789abcdef\n","CONFIRM AAIS 0123456789abcdef \n",
        "CONFIRM AAIS 0123456789abcdef","CONFIRM AAIS 0123456789abcdef\n\n",
        "CONFIRM AAIS 0123456789abcdef\r\n","\033[32mCONFIRM AAIS 0123456789abcdef\n","CANCEL\n"};
    for(size_t i=0;i<sizeof(wrong)/sizeof(wrong[0]);i++) {
        s=begin(); confirm_finish(&s,&op,wrong[i],strlen(wrong[i]),1001,true);
        CHECK(s.state==CONFIRM_REJECTED);
        CHECK(!strcmp(confirm_finish(&s,&op,yes,strlen(yes),1002,true),"already-finished"));
    }
    s=begin(); CHECK(!strcmp(confirm_finish(&s,&op,NULL,0,1001,true),"end-of-input"));
    char long_line[129]; memset(long_line,'x',sizeof(long_line));
    s=begin(); CHECK(!strcmp(confirm_finish(&s,&op,long_line,sizeof(long_line),1001,true),"input-too-long"));
    char binary_line[64]; strcpy(binary_line,yes); binary_line[5]=0;
    s=begin(); confirm_finish(&s,&op,binary_line,strlen(yes),1001,true); CHECK(s.state==CONFIRM_REJECTED);
    uint64_t times[]={999,61000,61001,UINT64_MAX};
    for(size_t i=0;i<4;i++) { s=begin(); CHECK(!strcmp(confirm_finish(&s,&op,yes,strlen(yes),times[i],true),"expired")); }
    s=begin(); CHECK(!strcmp(confirm_finish(&s,&op,yes,strlen(yes),1001,false),"origin-changed"));
    const char *events[]={"cancelled","expired","interrupted","tty-changed","input-disconnected"};
    for(size_t i=0;i<5;i++) {
        s=begin(); confirm_abort(&s,events[i]); CHECK(s.state==CONFIRM_REJECTED);
        CHECK(!strcmp(confirm_finish(&s,&op,yes,strlen(yes),1002,true),"already-finished"));
    }
    for(unsigned field=0;field<8;field++) {
        ConfirmOperation changed=op;
        char *values[]={changed.project,changed.operation,changed.target,changed.region,
            changed.host_identity,changed.repository,changed.release,changed.digest};
        values[field][0]='X'; s=begin();
        CHECK(!strcmp(confirm_finish(&s,&changed,yes,strlen(yes),1001,true),"operation-changed"));
        CHECK(!confirm_begin(&s,&changed,"0123456789abcdef",1000));
    }
    const char bad[]={'\n','\r','\033','\t',127};
    for(size_t i=0;i<sizeof(bad);i++) { ConfirmOperation changed=op; changed.target[2]=bad[i]; CHECK(!confirm_valid_operation(&changed)); }
    ConfirmOperation changed=op; memset(changed.target,'a',sizeof(changed.target)); CHECK(!confirm_valid_operation(&changed));
    CHECK(!confirm_begin(&s,&op,"",1000)); CHECK(!confirm_begin(&s,&op,"0123456789abcdeg",1000));
    CHECK(!confirm_begin(&s,&op,"0123456789abcdef\n",1000));
    printf("AAIS_TERMINAL_CONFIRM_ASSERTIONS=%u\n",checks);
    puts("Offline state/input fixtures only; no Terminal, credentials or authorization.");
}
